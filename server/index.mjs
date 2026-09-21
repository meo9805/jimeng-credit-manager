import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, fail, hash, shape, identifier, validateIngest, validateInstallation, validateIdentityMapping, validateCommandResult, validateDiagnostics, validateDepartment, validateEmployee, validateAccountOwnership } from './domain.mjs';
import { createStore } from './store.mjs';
import { readCollectorRelease, collectorVersionStatus } from './collector-release.mjs';
import { createAdminPassword } from './admin-password.mjs';
import { installHelperEntries } from './install-helper.mjs';
import { installGuideEntries } from './install-guide.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 512 * 1024;
// Cover the collector's 30-entry offline queue plus its current five-page scan.
// Further uploads refill at 60/minute without sharing a budget across employees.
const INGEST_BURST = 40;
const INGEST_REFILL_MS = 1000;
const extensionPaths = new Set(['/api/ingest','/api/collector/status','/api/collector/commands','/api/collector/diagnostics','/api/collector/extension.zip','/api/admin/extension-login']);
const commandResultPath = /^\/api\/collector\/commands\/([^/]+)\/result$/;
const isExtensionPath = pathname => extensionPaths.has(pathname) || commandResultPath.test(pathname);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.woff2':'font/woff2'};

function readAdminSecret(dataDir) {
  mkdirSync(dataDir,{recursive:true,mode:0o700}); chmodSync(dataDir,0o700);
  const filename = path.join(dataDir,'admin-secret');
  if (!existsSync(filename)) {
    try { writeFileSync(filename,randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'}); }
    catch(error) { if(error.code !== 'EEXIST') throw error; }
  }
  if (lstatSync(filename).isSymbolicLink()) throw new Error('管理员密钥文件不能是符号链接');
  chmodSync(filename,0o600);
  const secret = readFileSync(filename,'utf8').trim();
  if (secret.length < 32 || secret.length > 256) throw new Error('管理员密钥文件格式无效');
  return secret;
}
function readJson(request) {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) fail('请求必须使用 application/json',415);
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY) { request.resume(); fail('请求数据过大',413); }
  return new Promise((resolve,reject)=>{
    let size=0, chunks=[], settled=false;
    const rejectOnce=error=>{if(!settled){settled=true;reject(error);}};
    request.on('data',chunk=>{
      size+=chunk.length;
      if(size>MAX_BODY){chunks=[];rejectOnce(new HttpError(413,'请求数据过大'));return;}
      if(!settled) chunks.push(chunk);
    });
    request.on('end',()=>{
      if(settled)return;
      settled=true;
      try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new HttpError(400,'JSON 格式不正确'));}
    });
    request.on('error',()=>rejectOnce(new HttpError(400,'读取请求失败')));
    request.on('aborted',()=>rejectOnce(new HttpError(400,'请求已中断')));
  });
}

export function createApp({dataDir=path.join(root,'.local'),distDir=path.join(root,'dist'),extensionDir=path.join(root,'extension'),clock=Date.now,publicOrigin=null,managementOrigin=null,collectorInternalOrigin=null,bindHost='127.0.0.1'}={}) {
  for(const value of [publicOrigin,managementOrigin,collectorInternalOrigin].filter(Boolean)) {
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==value||url.username||url.password)throw new Error('服务地址必须是完整的 HTTP(S) origin');
  }
  const configuredOrigins=[...new Set([managementOrigin,publicOrigin,collectorInternalOrigin].filter(Boolean))];
  const secret=readAdminSecret(dataDir), store=createStore({dataDir,secret,clock});
  const adminPassword=createAdminPassword(store);
  const collectorRelease=()=>({...readCollectorRelease(extensionDir),announcedVersion:null,announcedAt:null,...store.getReleaseAnnouncement()});
  const sessions=new Map(), loginFailures=new Map(), loginTickets=new Map();
  const ingestBuckets=new Map();
  let nextIngestSweep=0;
  let closed=false;
  const server=http.createServer((request,response)=>{ handle(request,response).catch(error=>{
    if(response.headersSent){response.end();return;}
    json(response,error instanceof HttpError ? error.status : 500,{error:error instanceof HttpError ? error.message : '服务暂时无法处理请求'});
  }); });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
  function json(response,status,data) {
    response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(JSON.stringify(data));
  }
  function originForRequest(request) {
    if(configuredOrigins.length){
      const matched=configuredOrigins.find(value=>new URL(value).host===request.headers.host);
      if(!matched)fail('Host 不被允许',403);
      return matched;
    }
    const address=server.address(), port=typeof address === 'object' && address ? address.port : 4318;
    if (![`127.0.0.1:${port}`,`localhost:${port}`].includes(request.headers.host)) fail('Host 不被允许',403);
    return `http://${request.headers.host}`;
  }
  function checkOrigin(request,response,pathname,origin) {
    const supplied=request.headers.origin;
    if(!supplied){
      if(request.headers['sec-fetch-site']==='cross-site')fail('跨站请求不被允许',403);
      return;
    }
    const isExtension=/^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/.test(supplied);
    if(supplied!==origin && !(isExtension && isExtensionPath(pathname))) fail('Origin 不被允许',403);
    response.setHeader('Vary','Origin');
    response.setHeader('Access-Control-Allow-Origin',supplied);
    if(!isExtension)response.setHeader('Access-Control-Allow-Credentials','true');
  }
  function method(request,response,allowed) {
    if(!allowed.includes(request.method)){response.setHeader('Allow',allowed.join(', '));fail('请求方法不被允许',405);}
  }
  function session(request) {
    const match=(request.headers.cookie ?? '').split(';').map(s=>s.trim()).find(s=>s.startsWith('jmc_admin='));
    if(!match)return null;
    const token=match.slice('jmc_admin='.length);
    if(token.length>200)return null;
    const key=hash(token), value=sessions.get(key);
    if(!value)return null;
    if(value.expiresAt<=clock()){sessions.delete(key);return null;}
    if(value.installationId){
      try{const device=store.getInstallation(value.installationId);if(!device.enabled || device.role!=='admin'){sessions.delete(key);return null;}}catch{sessions.delete(key);return null;}
    }
    return {...value,key};
  }
  function admin(request){const value=session(request);if(!value)fail('请先验证管理员身份',401);return value;}
  function collector(request){
    const match=/^Bearer (jmc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    const device=match ? store.authenticate(match[1]) : null;
    if(!device)fail('采集设备凭据无效或已停用',401);
    return device;
  }
  function limitIngest(request,response,installationId){
    const at=clock();
    if(at>=nextIngestSweep){
      for(const [id,bucket] of ingestBuckets)if(at-bucket.updatedAt>=INGEST_BURST*INGEST_REFILL_MS)ingestBuckets.delete(id);
      nextIngestSweep=at+60_000;
    }
    const previous=ingestBuckets.get(installationId);
    const tokens=previous?Math.min(INGEST_BURST,previous.tokens+Math.max(0,at-previous.updatedAt)/INGEST_REFILL_MS):INGEST_BURST;
    const bucket={tokens,updatedAt:Math.max(at,previous?.updatedAt??at)};
    ingestBuckets.set(installationId,bucket);
    if(tokens<1){
      response.setHeader('Retry-After',String(Math.max(1,Math.ceil((1-tokens)*INGEST_REFILL_MS/1000))));
      response.setHeader('Access-Control-Expose-Headers','Retry-After');
      request.resume();
      fail('采集上报过于频繁，请稍后重试',429);
    }
    // Reserve before reading the asynchronous body, including parallel uploads.
    bucket.tokens--;
  }
  function issueSession(response,installationId=null){
    // Only hashes are retained in memory. A restart revokes all browser sessions.
    for(const [key,value] of sessions)if(value.expiresAt<=clock())sessions.delete(key);
    const token=randomBytes(32).toString('base64url');
    sessions.set(hash(token),{installationId,expiresAt:clock()+8*3600_000});
    response.setHeader('Set-Cookie',`jmc_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${managementOrigin?.startsWith('https:')?'; Secure':''}`);
  }
  async function extensionZip(device,origin){
    const {zipSync,strToU8}=await import('fflate');
    const files={};
    function walk(directory,prefix=''){
      for(const item of readdirSync(directory,{withFileTypes:true})){
        if(item.name.startsWith('.') || item.name==='node_modules' || item.name==='provision.json' || item.isSymbolicLink())continue;
        const relative=prefix+item.name,full=path.join(directory,item.name);
        if(item.isDirectory())walk(full,`${relative}/`);
        else if(item.isFile() && /\.(?:js|mjs|json|html|css|svg|png|ico|woff2)$/.test(item.name)){
          if(statSync(full).size>4*1024*1024)fail('扩展文件过大',500);
          files[relative]=new Uint8Array(readFileSync(full));
        }
      }
    }
    if(!existsSync(path.join(extensionDir,'manifest.json')))fail('扩展安装包尚未就绪',503);
    walk(extensionDir);
    const manifest=JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    // Chrome match patterns are host-scoped; the HTTP server additionally enforces the exact port and Origin.
    const endpoint=publicOrigin??origin, dashboardEndpoint=managementOrigin??origin;
    manifest.host_permissions=[...new Set(['https://jimeng.jianying.com/*',...[endpoint,...(collectorInternalOrigin?[collectorInternalOrigin]:[]),...(device.role==='admin'?[dashboardEndpoint]:[])].map(value=>{const url=new URL(value);return `${url.protocol}//${url.hostname}/*`})])];
    delete manifest.optional_host_permissions;
    files['manifest.json']=strToU8(JSON.stringify(manifest,null,2));
    files['provision.json']=strToU8(JSON.stringify({endpoint,...(collectorInternalOrigin?{internalEndpoint:collectorInternalOrigin}:{}),...(device.role==='admin'?{dashboardEndpoint}:{}),token:store.installationToken(device.id),installationId:device.id,employeeName:device.employeeName,department:device.department,role:device.role},null,2));
    Object.assign(files,installHelperEntries());
    Object.assign(files,installGuideEntries());
    return zipSync(files,{level:6});
  }
  async function handle(request,response){
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Cache-Control','no-store');
    const origin=originForRequest(request),url=new URL(request.url,origin),pathname=url.pathname;
    const collectionOnly=managementOrigin && origin!==managementOrigin;
    if(collectionOnly && pathname!=='/api/health' && (!isExtensionPath(pathname)||pathname==='/api/admin/extension-login'))fail('接口不存在',404);
    if(/^\/preview-(?:data|demo)\.json\/?$/.test(decodeURIComponent(pathname)))fail('文件不存在',404);
    checkOrigin(request,response,pathname,origin);
    if(request.method==='OPTIONS'){
      if(!isExtensionPath(pathname))fail('此接口不提供跨域访问',403);
      const allow=['/api/collector/status','/api/collector/commands','/api/collector/extension.zip'].includes(pathname) ? 'GET' : 'POST';
      if(request.headers['access-control-request-method']!==allow)fail('预检请求方法不被允许',405);
      const requested=(request.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      if(requested.some(key=>!['authorization','content-type'].includes(key)))fail('预检请求头不被允许',403);
      response.writeHead(204,{'Access-Control-Allow-Methods':allow,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'300'});response.end();return;
    }
    if(pathname==='/api/health'){method(request,response,['GET']);json(response,200,{ok:true,version:'1.0.0'});return;}
    if(pathname==='/api/session'){method(request,response,['GET']);const authenticated=Boolean(session(request));json(response,200,{authenticated,role:authenticated?'admin':null});return;}
    if(pathname==='/api/admin/login'){
      method(request,response,['POST']);const body=shape(await readJson(request),['secret','password'],'登录请求');
      if(Number(Object.hasOwn(body,'secret'))+Number(Object.hasOwn(body,'password'))!==1)fail('请提供登录密码');
      const attempt=loginFailures.get(request.socket.remoteAddress);
      if(attempt && attempt.until>clock() && attempt.count>=10)fail('尝试次数过多，请稍后重试',429);
      // Reserve the attempt before asynchronous scrypt work to bound parallel guesses.
      loginFailures.set(request.socket.remoteAddress,{count:attempt && attempt.until>clock()?attempt.count+1:1,until:clock()+15*60_000});
      const supplied=typeof body.secret==='string' && body.secret.length<=256 ? body.secret.trim() : '';
      const usingPassword=Object.hasOwn(body,'password');
      const bootstrap=usingPassword&&!adminPassword.configured()&&typeof body.password==='string'&&body.password.length<=256?body.password.trim():supplied;
      const accepted=usingPassword&&adminPassword.configured()?await adminPassword.verify(body.password):timingSafeEqual(Buffer.from(hash(bootstrap),'hex'),Buffer.from(hash(secret),'hex'));
      if(!accepted)fail(Object.hasOwn(body,'password')?'登录密码不正确':'管理员密钥不正确',401);
      loginFailures.delete(request.socket.remoteAddress);issueSession(response);json(response,200,{authenticated:true,role:'admin'});return;
    }
    if(pathname==='/api/admin/password'){
      method(request,response,['POST']);const current=admin(request);
      if(request.headers.origin!==origin)fail('请从管理页面设置密码',403);
      const body=shape(await readJson(request),['password'],'登录密码');await adminPassword.set(body.password);
      for(const key of sessions.keys())if(key!==current.key)sessions.delete(key);
      json(response,200,{configured:true});return;
    }
    if(pathname==='/api/admin/logout'){
      method(request,response,['POST']);const value=session(request);if(value)sessions.delete(value.key);
      response.setHeader('Set-Cookie',`jmc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${managementOrigin?.startsWith('https:')?'; Secure':''}`);json(response,200,{authenticated:false});return;
    }
    if(pathname==='/api/admin/extension-login'){
      method(request,response,['POST']);const device=collector(request);if(device.role!=='admin')fail('此设备没有管理权限',403);
      for(const [key,value] of loginTickets)if(value.expiresAt<=clock())loginTickets.delete(key);
      const ticket=randomBytes(32).toString('base64url');
      loginTickets.set(hash(ticket),{installationId:device.id,expiresAt:clock()+60_000});
      json(response,200,{ticket,dashboardUrl:managementOrigin??origin});return;
    }
    if(pathname==='/api/admin/consume-ticket'){
      method(request,response,['POST']);
      if(request.headers.origin!==origin)fail('请从管理页面登录',403);
      const body=shape(await readJson(request),['ticket'],'登录请求');
      if(typeof body.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.ticket))fail('登录凭据无效或已过期',401);
      const key=hash(body.ticket),value=loginTickets.get(key);loginTickets.delete(key);
      if(!value||value.expiresAt<=clock())fail('登录凭据无效或已过期',401);
      const device=store.getInstallation(value.installationId);
      if(!device.enabled||device.role!=='admin')fail('此设备没有管理权限',403);
      issueSession(response,device.id);json(response,200,{authenticated:true,role:'admin'});return;
    }
    if(pathname==='/api/collector/status'){
      method(request,response,['GET']);const device=collector(request);
      const extensionRelease=collectorRelease();
      json(response,200,{employeeName:device.employeeName,department:device.department,role:device.role,enabled:device.enabled,lastSeenAt:device.lastSeenAt,lastCommandPollAt:device.lastCommandPollAt,online:device.online,dashboardUrl:device.role==='admin'?(managementOrigin??origin):null,
        extensionRelease,extensionVersion:device.extensionVersion,extensionVersionObservedAt:device.extensionVersionObservedAt,...collectorVersionStatus(device,extensionRelease)});return;
    }
    if(pathname==='/api/collector/extension.zip'){
      method(request,response,['GET']);const device=collector(request),zip=await extensionZip(device,origin);
      response.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="jimeng-collector-${device.id}.zip"`,'Cache-Control':'no-store, private','Content-Length':zip.length});response.end(zip);return;
    }
    if(pathname==='/api/collector-release/publish'){
      method(request,response,['POST']);admin(request);
      if(request.headers.origin!==origin)fail('请从管理页面发布更新',403);
      shape(await readJson(request),[],'采集器发布');const release=collectorRelease();
      json(response,200,{...release,...store.announceRelease(release.version)});return;
    }
    if(pathname==='/api/collector/commands'){
      method(request,response,['GET']);json(response,200,store.pollCommands(collector(request)));return;
    }
    if(pathname==='/api/collector/diagnostics'){
      method(request,response,['POST']);const device=collector(request);
      json(response,200,store.recordDiagnostics(device,validateDiagnostics(await readJson(request),clock())));return;
    }
    const diagnosticMatch=/^\/api\/installations\/([^/]+)\/diagnostics$/.exec(pathname);
    if(diagnosticMatch){
      method(request,response,['GET']);admin(request);
      const id=decodeURIComponent(diagnosticMatch[1]);identifier(id,'采集端 ID');
      json(response,200,store.diagnostics(id));return;
    }
    const commandMatch=commandResultPath.exec(pathname);
    if(commandMatch){
      method(request,response,['POST']);const device=collector(request);
      let requestId;try{requestId=decodeURIComponent(commandMatch[1]);}catch{fail('同步任务 ID 格式不正确');}
      identifier(requestId,'同步任务 ID');
      json(response,200,store.recordCommandResult(device,requestId,validateCommandResult(await readJson(request))));return;
    }
    if(pathname==='/api/ingest'){
      method(request,response,['POST']);const device=collector(request);
      limitIngest(request,response,device.id);
      const body=validateIngest(await readJson(request),clock());
      json(response,200,store.ingest(device,body));return;
    }
    if(pathname==='/api/dashboard'){
      method(request,response,['GET']);admin(request);const mode=url.searchParams.get('mode')??'live';
      if(mode!=='live')fail('只提供正式使用数据');
      const release=collectorRelease(),version=hash(JSON.stringify([store.dashboardVersion(),release]));
      const etag=`W/"${version}"`;
      const headers={'ETag':etag,'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff'};
      const candidates=(request.headers['if-none-match']??'').split(',').map(value=>value.trim().replace(/^W\//,''));
      if(candidates.includes('*')||candidates.includes(`"${version}"`)){response.writeHead(304,headers);response.end();return;}
      const data=store.dashboard();
      response.writeHead(200,{...headers,'Content-Type':'application/json; charset=utf-8'});
      response.end(JSON.stringify({...data,adminPasswordConfigured:adminPassword.configured(),collectorRelease:release,installations:data.installations.map(device=>({...device,...collectorVersionStatus(device,release)}))}));return;
    }
    if(pathname==='/api/installations'){
      method(request,response,['POST']);admin(request);json(response,201,store.createInstallation(validateInstallation(await readJson(request))));return;
    }
    if(pathname==='/api/departments'||pathname==='/api/employees'){
      method(request,response,['GET','POST']);admin(request);
      const isDepartment=pathname==='/api/departments';
      if(request.method==='GET'){json(response,200,isDepartment?store.departments():store.employees());return;}
      const body=await readJson(request);
      json(response,201,isDepartment?store.createDepartment(validateDepartment(body)):store.createEmployee(validateEmployee(body)));return;
    }
    const directoryMatch=/^\/api\/(departments|employees)\/([^/]+)$/.exec(pathname);
    if(directoryMatch){
      method(request,response,['PATCH','DELETE']);admin(request);
      let id;try{id=decodeURIComponent(directoryMatch[2]);}catch{fail('目录 ID 格式不正确');}
      identifier(id,'目录 ID');const isDepartment=directoryMatch[1]==='departments';
      if(request.method==='DELETE'){json(response,200,isDepartment?store.deleteDepartment(id):store.deleteEmployee(id));return;}
      const body=await readJson(request);
      json(response,200,isDepartment?store.patchDepartment(id,validateDepartment(body)):store.patchEmployee(id,validateEmployee(body,true)));return;
    }
    if(pathname==='/api/sync-requests'){
      method(request,response,['POST']);admin(request);shape(await readJson(request),[],'同步请求');
      json(response,200,store.createSyncRequest());return;
    }
    const syncMatch=/^\/api\/sync-requests\/([^/]+)$/.exec(pathname);
    if(syncMatch){
      method(request,response,['GET']);admin(request);
      let requestId;try{requestId=decodeURIComponent(syncMatch[1]);}catch{fail('同步任务 ID 格式不正确');}
      identifier(requestId,'同步任务 ID');json(response,200,store.getSyncRequest(requestId));return;
    }
    const zipMatch=/^\/api\/installations\/([^/]+)\/extension\.zip$/.exec(pathname);
    if(zipMatch){
      method(request,response,['GET']);admin(request);const id=decodeURIComponent(zipMatch[1]),device=store.getInstallation(id),zip=await extensionZip(device,origin);
      response.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="jimeng-collector-${device.id}.zip"`,'Cache-Control':'no-store, private','Content-Length':zip.length});response.end(zip);return;
    }
    const skipBindingMatch=/^\/api\/installations\/([^/]+)\/skip-initial-binding$/.exec(pathname);
    if(skipBindingMatch){
      method(request,response,['POST']);admin(request);
      let id;try{id=decodeURIComponent(skipBindingMatch[1]);}catch{fail('采集端 ID 格式不正确');}
      identifier(id,'采集端 ID');shape(await readJson(request),[],'首次绑定处理');
      json(response,200,store.skipInitialBinding(id));return;
    }
    const installationMatch=/^\/api\/installations\/([^/]+)$/.exec(pathname);
    if(installationMatch){
      method(request,response,['PATCH','DELETE']);admin(request);
      let id;try{id=decodeURIComponent(installationMatch[1]);}catch{fail('采集端 ID 格式不正确');}
      identifier(id,'采集端 ID');
      if(request.method==='DELETE'){json(response,200,store.deleteInstallation(id));return;}
      json(response,200,store.patchInstallation(id,validateInstallation(await readJson(request),true)));return;
    }
    const accountMatch=/^\/api\/accounts\/([^/]+)$/.exec(pathname);
    if(accountMatch){
      method(request,response,['PATCH']);admin(request);const result=validateAccountOwnership(await readJson(request));
      json(response,200,store.patchAccount(decodeURIComponent(accountMatch[1]),result));return;
    }
    const identityMatch=/^\/api\/identities\/([^/]+)$/.exec(pathname);
    if(identityMatch){
      method(request,response,['PATCH']);admin(request);
      let platformUserId;try{platformUserId=decodeURIComponent(identityMatch[1]);}catch{fail('平台用户 ID 格式不正确');}
      identifier(platformUserId,'平台用户 ID');
      json(response,200,store.patchIdentity(platformUserId,validateIdentityMapping(await readJson(request))));return;
    }
    if(pathname.startsWith('/api/'))fail('接口不存在',404);
    method(request,response,['GET','HEAD']);
    let decoded;try{decoded=decodeURIComponent(pathname);}catch{fail('路径格式不正确');}
    if(decoded.includes('\0') || decoded.split('/').some(part=>part.startsWith('.')))fail('文件不存在',404);
    const resolved=path.resolve(distDir,`.${decoded}`),distRoot=path.resolve(distDir);
    if(resolved!==distRoot && !resolved.startsWith(distRoot+path.sep))fail('文件不存在',404);
    let filename=resolved;
    if(!existsSync(filename) || !statSync(filename).isFile()){
      if(path.extname(decoded))fail('文件不存在',404);
      filename=path.join(distRoot,'index.html');
    }
    if(!existsSync(filename))fail('管理页面尚未构建，请运行 npm run build',503);
    if(lstatSync(filename).isSymbolicLink())fail('文件不存在',404);
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    response.writeHead(200,{'Content-Type':mime[path.extname(filename)]??'application/octet-stream'});
    response.end(request.method==='HEAD'?undefined:readFileSync(filename));
  }
  async function start(port=4318){
    if(server.listening)return `http://127.0.0.1:${server.address().port}`;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bindHost,()=>{server.removeListener('error',reject);resolve();});});
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function close(){
    if(closed)return;closed=true;
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    sessions.clear();ingestBuckets.clear();store.close();
  }
  return {server,start,close};
}

export async function start(options={}){const app=createApp(options);await app.start(options.port??4318);return app;}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await start({port:Number(process.env.PORT??4318),bindHost:process.env.BIND_HOST??'127.0.0.1',...(process.env.DATA_DIR?{dataDir:process.env.DATA_DIR}:{}),publicOrigin:process.env.PUBLIC_ORIGIN||null,managementOrigin:process.env.MANAGEMENT_ORIGIN||null,collectorInternalOrigin:process.env.COLLECTOR_INTERNAL_ORIGIN||null});
  process.stdout.write('即梦积分管家服务已启动\n');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{app.close().then(()=>process.exit(0));});
}
