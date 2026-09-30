// Chrome serializes this function into the page's MAIN world. Keep it self-contained.
// Use the page's read-only credit service; never open panels, change login, or export credentials.
export async function readJimengPage(options = {}) {
  const { previousAccount = null, previousEventId = null, previousCursor = null, pendingHeadEventId = null,
    collectAllSpaces = false, previousCollections = {}, targetAccount = null, recoveryAttempt = 0, expectedUserId = null } = options;
  const timestamp = () => new Date().toISOString();
  const fail = (status, message, code) => ({ observedAt: timestamp(), status, message, ...(code ? {diagnosticCodes:[code]} : {}) });
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  const recover = async (message, code, retained = []) => {
    // Retry only the outer collection. Its fresh discovery must never reuse a team
    // target or account service captured under a different login.
    if (collectAllSpaces && recoveryAttempt < 1) {
      await pause();
      const next = await readJimengPage({...options,recoveryAttempt:recoveryAttempt+1});
      const nextObservations = Array.isArray(next.observations) ? next.observations : [next];
      const observations = [...retained,...nextObservations];
      const recovered = nextObservations.some(item => item.status === 'ok' &&
        (item.balanceFresh !== false || item.canReadTeamTotal || item.records?.length || item.creditSourceFacts?.length));
      return {...next,...(retained.length ? {status:'ok',observations,partial:true} : {}),
        diagnosticCodes:[...new Set([code,...(next.diagnosticCodes || []),...(recovered ? ['account_read_recovered'] : [])])]};
    }
    const result = fail('error', message, code);
    // A completed, identity-checked read remains valid after a later login change.
    // Only the unfinished response is omitted; stored account history is untouched.
    return retained.length ? {status:'ok',observedAt:timestamp(),message,partial:true,observations:[...retained,result],diagnosticCodes:[code]} : result;
  };
  if (location.origin !== 'https://jimeng.jianying.com') return fail('error', '非即梦页面');
  const feature = window.__debugger?.DreaminaCommercialFeatureService;
  const credit = feature?.commercialCreditService || feature?._commercialCreditService;
  const port = feature?._commerceAccountPort;
  if (!credit || !port?.getSnapshot) return recover('即梦页面服务未就绪，下次自动重试', 'page_not_ready');
  const user = port.getSnapshot();
  if (!user?.hasLogin || !user.userId) return fail('login_required', '即梦登录已失效，请重新登录即梦', 'page_login_required');
  if (expectedUserId !== null && String(user.userId) !== expectedUserId) return fail('error', '账号切换中，等待重新读取', 'account_context_changed');
  const identity = credit.getCurrentAccountSnapshot?.();
  const visibleAccount = identity?.account || credit.currentAccount || credit._currentAccount;
  const scoped = collectAllSpaces || Boolean(targetAccount), initiallyReady = Boolean(credit.isLocalCreditReady);
  if (!scoped && (!visibleAccount || !initiallyReady)) return fail('error', '即梦积分页面尚未就绪，下次自动重试', 'page_not_ready');
  // Explicitly scoped HTTP reads do not depend on the UI's cached credit-ready
  // flag. A stable authenticated login is still required before and after every read.
  const account = targetAccount || visibleAccount || {accountType:'personal',accountKey:'personal'};
  const userId = String(user.userId), accountKey = account.accountKey;
  const team = account.accountType === 'team';
  const poolAccess = team && account.capability?.canAllocateTeamCredit === true;
  const ledgerScope = poolAccess ? 'team_total' : team ? 'team_member' : 'personal';
  const collectionKey = `${userId}:${accountKey}:${ledgerScope}`;
  const sameAccount = () => {
    const liveFeature = window.__debugger?.DreaminaCommercialFeatureService;
    if (liveFeature !== feature || (liveFeature?.commercialCreditService || liveFeature?._commercialCreditService) !== credit || liveFeature?._commerceAccountPort !== port) return false;
    const next = credit.getCurrentAccountSnapshot?.();
    const currentUser=port.getSnapshot();
    return Boolean(credit.isLocalCreditReady) === initiallyReady && currentUser?.hasLogin && String(currentUser.userId) === userId &&
      (next?.account || credit.currentAccount || credit._currentAccount)?.accountKey === visibleAccount?.accountKey &&
      (identity?.version === undefined || next?.version === identity.version);
  };
  const changed = retained => recover('账号切换中，等待重新读取', 'account_context_changed', retained);
  if (collectAllSpaces && (!initiallyReady || !visibleAccount)) {
    await pause();
    if (!sameAccount()) return changed();
  }
  const amount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const name = v => typeof v === 'string' ? v.slice(0, 100) : '';
  // Preserve bounded platform scalars before accounting rules run on the server.
  // In particular, a numeric history/submit ID and a signed credit change must
  // not disappear merely because the current client projection cannot use it.
  const rawId = v => typeof v === 'string' && v.length <= 160 ? v :
    typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null;
  const rawScalar = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12 ? v :
    typeof v === 'string' && v.length <= 160 ? v : null;
  const rawCount = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e9 ? v : null;
  let subscriptionFacts = [], creditSourceFacts = [];
  let sourceChars = 0, sourceCapturePartial = false;
  const secretKey = /authorization|cookie|session|password|passwd|token|secret|authkey|apikey|privatekey|sign|csrf|credential|captcha|ticket|prompt|image|video|avatar|cover|media|fileurl|asseturl|downloadurl|url|uri|href|link/i;
  const secretValue = /(?:cookie|sessionid|sid_tt|authorization|bearer|password|api[_-]?key|access_token|refresh_token|authkey)\s*[:=]|https?:\/\/|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/i;
  const safeSourceKey = key => Boolean(key) && key.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(key) &&
    !['__proto__','prototype','constructor'].includes(key) && !secretKey.test(key.replace(/[^a-z]/gi,''));
  const scrub = (value,depth=0) => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      if (secretValue.test(value)) return null;
      if (value.length>1000) sourceCapturePartial=true;
      return value.slice(0,1000).replace(/[\u0000-\u001f\u007f]/gu,' ');
    }
    if (depth >= 6) { sourceCapturePartial=true; return null; }
    if (Array.isArray(value)) {
      if (value.length>200) sourceCapturePartial=true;
      return value.slice(0,200).map(item=>scrub(item,depth+1));
    }
    if (!value || typeof value !== 'object') return null;
    const result = {};
    const keys=Object.keys(value);
    if (keys.length>100) sourceCapturePartial=true;
    for (const key of keys.slice(0,100)) {
      if (!safeSourceKey(key)) continue;
      result[key] = scrub(value[key],depth+1);
    }
    return result;
  };
  const captureSource = (source,value,extra={}) => {
    if (value == null) return;
    const queryScope = extra.queryScope || ledgerScope;
    const context = {source,loginUserId:userId,teamId:team ? rawId(account.teamId) : null,queryScope,readAt:timestamp()};
    // Split long top-level arrays before scrubbing. Scrubbing an entire array
    // first would silently discard every entry after the 200th item.
    const oversizedArray = value && typeof value === 'object' && !Array.isArray(value) &&
      Object.entries(value).some(([key,item]) => safeSourceKey(key) && Array.isArray(item) && item.length > 200);
    const clean = oversizedArray ? null : scrub(value);
    const wrapper = extra.scene ? {scene:extra.scene,data:clean} : extra.cursor != null ? {cursor:String(extra.cursor).slice(0,160),data:clean} : clean;
    const emit = payload => {
      const size = JSON.stringify(payload).length;
      if (size > 40000) return false;
      if (sourceChars + size > 1000000 || creditSourceFacts.length >= 64) {sourceCapturePartial=true;return false;}
      creditSourceFacts.push({...context,payload}); sourceChars += size; return true;
    };
    if (!oversizedArray && emit(wrapper)) return;
    if ((!oversizedArray && (!clean || typeof clean !== 'object' || Array.isArray(clean))) ||
        (oversizedArray && (typeof value !== 'object' || Array.isArray(value)))) {
      sourceCapturePartial=true; return;
    }
    // Large catalogue/member/history responses are split without interpreting
    // their business fields. Repeated equivalent arrays are referenced once.
    const metadata = {}, arrays = [], seen = new Map(), aliases = {};
    const entries = oversizedArray ? Object.entries(value) : Object.entries(clean);
    if (entries.length > 100) sourceCapturePartial=true;
    for (const [key,item] of entries.slice(0,100)) {
      if (!safeSourceKey(key)) continue;
      if (!Array.isArray(item)) {metadata[key]=oversizedArray ? scrub(item,1) : item;continue;}
      const signature = oversizedArray ? item : JSON.stringify(item);
      if (seen.has(signature)) aliases[key]=seen.get(signature);
      else {seen.set(signature,key);arrays.push([key,item]);}
    }
    if(!emit({...(extra.scene ? {scene:extra.scene} : {}),...(extra.cursor != null ? {cursor:String(extra.cursor).slice(0,160)} : {}),
      part:'metadata',data:metadata,arrayAliases:aliases,arrayFields:arrays.map(([key,items])=>({key,count:items.length}))})) sourceCapturePartial=true;
    for (const [field,items] of arrays) for (let offset=0;offset<items.length;) {
      let count=Math.min(10,items.length-offset),payload;
      do {
        payload={...(extra.scene ? {scene:extra.scene} : {}),
          ...(extra.cursor != null ? {cursor:String(extra.cursor).slice(0,160)} : {}),
          part:'array',field,offset,total:items.length,
          items:items.slice(offset,offset+count).map(item => oversizedArray ? scrub(item,2) : item)};
        if (JSON.stringify(payload).length<=40000) break;
        count=Math.floor(count/2);
      } while(count>0);
      if (!count || !emit(payload)) {sourceCapturePartial=true;return;}
      offset+=count;
    }
  };
  const identityOnly = (message, code) => {
    if(!sameAccount())return fail('error','账号切换中，等待重新读取','account_context_changed');
    // A stale page flag alone is not enough to emit a new login binding. Recovery
    // must first obtain a fresh response from the explicitly scoped credit endpoint.
    if(!initiallyReady || !visibleAccount)return fail('error',message,code);
    const continuing=previousAccount===collectionKey;
    return {observedAt:timestamp(),status:'ok',message,partial:true,collectionKey,
      diagnosticCodes:[code,...(sourceCapturePartial ? ['source_capture_partial'] : [])],
      userId,displayName:name(user.userProfile?.name)||'即梦账号',accountType:account.accountType,
      teamId:account.teamId==null?null:String(account.teamId),teamName:name(account.displayInfo?.teamName),
      balanceFresh:false,canReadTeamTotal:false,ledgerScope,records:[],
      ...(subscriptionFacts.length ? {subscriptionFacts} : {}),
      ...(creditSourceFacts.length ? {creditSourceFacts} : {}),
      ...(sourceCapturePartial ? {sourceCapturePartial:true} : {}),
      headEventId:continuing?previousEventId:null,nextCursor:continuing?previousCursor:null,
      pendingHeadEventId:continuing?pendingHeadEventId:null};
  };
  const withTimeout = (promise, ms = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
  const readBalance = result => {
    if (!result?.ok) return null;
    const v = result.value, c = v?.credit;
    const parts = [amount(c?.giftCredit), amount(c?.purchaseCredit), amount(c?.vipCredit)];
    if (parts.some(p => p === null)) return null;
    const creditBatches = [];
    let creditBatchesComplete = true;
    for (const [kind, key, expected] of [['subscription', 'vipCredits', parts[2]], ['gift', 'giftCredits', parts[0]], ['purchase', 'purchaseCredits', parts[1]]]) {
      const list = v.creditsDetail?.[key];
      if (!Array.isArray(list)) {
        if (expected !== 0 || list != null) creditBatchesComplete = false;
        continue;
      }
      let sum = 0;
      for (const item of list) {
        const residual = amount(item?.residualCredits);
        if (residual === null) { creditBatchesComplete = false; continue; }
        if (residual === 0) continue;
        sum += residual;
        if (creditBatches.length >= 200) { creditBatchesComplete = false; continue; }
        const end = Number(item.creditsLifeEnd);
        const date = Number.isFinite(end) && end > 0 ? new Date(end * 1000) : null;
        creditBatches.push({ kind, amount: residual, expiresAt: date && Number.isFinite(date.valueOf()) ? date.toISOString() : null });
      }
      if (!Number.isFinite(sum) || Math.abs(sum - expected) > 0.000001) creditBatchesComplete = false;
    }
    const expiry = creditBatches.map(batch => batch.expiresAt).filter(Boolean).sort();
    return { balance: parts.reduce((a,b) => a+b,0), giftCredit:parts[0], purchaseCredit:parts[1], vipCredit:parts[2], allocatableBalance:amount(v.allocatableCredit),
      expiresAt: expiry[0] || null, creditBatches, creditBatchesComplete };
  };
  const resolve = serviceName => {
    // Resolve only this known service registration, without reading other services or their state.
    const root = feature._containerService;
    let key;
    for (let container = root; container; container = container._parent) {
      key = [...container.services.entries].find(([k]) => String(k) === serviceName)?.[0];
      if (key) break;
    }
    return key ? root.invokeFunction(accessor => accessor.get(key)) : null;
  };
  if (collectAllSpaces) {
    const targets = [{accountType:'personal',accountKey:'personal'}];
    let discoveryError = false;
    try {
      const data = resolve('commercial-team-workspace-service')?._teamManager?._teamworkDataService;
      if (!data?.getTeamList || !data?.getTeamInfo) throw new Error('team discovery unavailable');
      let cursor = '0';
      const seen = new Set();
      for (let page = 0; page < 5; page++) {
        const result = await withTimeout(data.getTeamList({cursor,count:50}));
        if (!result?.ok || !Array.isArray(result.value?.teamList)) throw new Error('team list unavailable');
        for (const item of result.value.teamList) {
          if (!item.teamId || seen.has(String(item.teamId))) continue;
          seen.add(String(item.teamId));
          let response;
          try {response = await withTimeout(data.getTeamInfo({teamId:String(item.teamId)}));}
          catch {discoveryError=true;continue;}
          const detail = response?.ok ? response.value?.teamInfo : null;
          if (!detail || String(detail.teamId)!==String(item.teamId)) { discoveryError = true; continue; }
          targets.push({accountType:'team',accountKey:`team:${detail.teamId}`,teamId:String(detail.teamId),
            displayInfo:{teamName:detail.teamName},capability:{canAllocateTeamCredit:detail.currentRole==='Owner'},detail});
        }
        if (result.value.hasMore === false) break;
        if (!result.value.nextCursor || result.value.nextCursor === cursor || page === 4) { discoveryError = true; break; }
        cursor = result.value.nextCursor;
      }
    } catch { discoveryError = true; }
    if (!sameAccount()) return changed();
    const observations = [];
    for (const target of targets) {
      if (!sameAccount()) return changed(observations.filter(item=>item.status==='ok'));
      const scope = target.accountType==='personal' ? 'personal' : target.capability?.canAllocateTeamCredit ? 'team_total' : 'team_member';
      const key = `${userId}:${target.accountKey}:${scope}`, saved = previousCollections[key] || {};
      observations.push(await readJimengPage({targetAccount:target,expectedUserId:userId,previousAccount:key,previousEventId:saved.eventId,
        previousCursor:saved.cursor,pendingHeadEventId:saved.pendingHead}));
      if (!sameAccount() || observations.at(-1)?.diagnosticCodes?.includes('account_context_changed')) return changed(observations.filter(item=>item.status==='ok'));
    }
    const fresh = observations.some(item=>item.status==='ok' &&
      (item.balanceFresh !== false || item.canReadTeamTotal || item.records?.length || item.creditSourceFacts?.length));
    if (!fresh && recoveryAttempt < 1) {
      const last = observations.at(-1);
      return recover(last?.message || '积分读取接口暂不可用，下次自动重试',last?.diagnosticCodes?.[0] || 'credit_api_unavailable');
    }
    return {status:'ok',observedAt:timestamp(),observations,partial:discoveryError || observations.some(x=>x.status!=='ok'||x.partial),
      diagnosticCodes:[...(discoveryError ? ['team_discovery_partial'] : []),...(!initiallyReady && fresh ? ['account_read_recovered'] : [])],
      message:discoveryError?'部分团队暂未发现，下次自动重试':'已同步个人与有效团队空间'};
  }
  let api;
  try {
    api = resolve('dreamina-credit-data-service');
  } catch { /* Unsupported page versions report unavailable instead of guessing a balance. */ }
  if (!api?.fetchUserCredit || !api?.fetchUserCreditHistory) return identityOnly('积分读取接口暂不可用，下次自动重试','credit_api_unavailable');
  let scopedRead;
  if (targetAccount) {
    try {
      // A private HTTP client reuses the site's request signing, but never its mutable
      // team selection or response-side account switching/retry handlers.
      const repository = api._creditRepository?.__origin__;
      const source = repository?._networkClient;
      if (!source?.create || !repository?._getApi) throw new Error('scoped reader unavailable');
      const client = source.create();
      client.interceptors.request.use(config => {
        config.headers ||= {};
        for (const key of Object.keys(config.headers)) if (key.toLowerCase()==='x-team-id') delete config.headers[key];
        if (team) config.headers['X-Team-Id'] = String(account.teamId);
        return config;
      });
      // Axios executes request handlers in reverse registration order. The final
      // handler above affects this client only, after the site's signing handlers.
      for (const handler of source.interceptors.request.handlers) if (handler) client.interceptors.request.use(handler.fulfilled,handler.rejected,{synchronous:handler.synchronous,runWhen:handler.runWhen});
      const camel = value => Array.isArray(value) ? value.map(camel) : value && typeof value==='object' ?
        Object.fromEntries(Object.entries(value).map(([key,v])=>[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),camel(v)])) : value;
      scopedRead = async (path,body) => {
        if (!sameAccount()) return {ok:false};
        const result = await client.post(repository._getApi(path),body,{timeout:8000});
        if (!sameAccount()) return {ok:false};
        const payload = result?.data;
        if (result.status!==200 || String(payload?.ret)!=='0') return {ok:false};
        const value=camel(payload.data);
        const source=path.endsWith('/user_credit_history') ? 'user_credit_history' :
          path.endsWith('/user_credit') ? 'user_credit' :
          path.endsWith('/subscription/user_info') ? 'user_info' :
          path.endsWith('/get_team_member_list') ? 'team_member_list' : null;
        const requestedScope=body?.query_scope || ledgerScope;
        if(source)captureSource(source,payload.data,{queryScope:requestedScope==='team_all'?'team_total':requestedScope,
          ...(['user_credit_history','team_member_list'].includes(source)?{cursor:body?.cursor??'0'}:{})});
        return {ok:true,value};
      };
      api = {fetchUserCredit:(_,options)=>scopedRead('/commerce/v1/benefits/user_credit',options?.queryScope?{query_scope:options.queryScope}:{}),
        fetchUserCreditHistory:(_,options)=>scopedRead('/commerce/v1/benefits/user_credit_history',{
          count:options.count,cursor:options.cursor,...(options.queryScope?{query_scope:options.queryScope}:{})})};
    } catch { return identityOnly('跨空间积分接口暂不可用，下次自动重试','credit_api_unavailable'); }
  }
  let own = null, pool = null, historyError = false, hasMore = false, headEventId = null;
  const continuing = previousAccount === collectionKey;
  let cursor = continuing && previousCursor ? previousCursor : '0';
  let nextCursor = null;
  if (continuing && previousCursor) headEventId = pendingHeadEventId;
  let subscription = null;
  let teamSnapshot = null;
  const readSubscription = async () => {
    try {
      const iso = value => Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value) * 1000).toISOString() : null;
      if (team) {
        const workspace = resolve('commercial-team-workspace-service');
        const result = targetAccount ? {ok:true,value:targetAccount.detail} : await withTimeout(workspace.refreshCurrentTeamDetail());
        if (!result?.ok) return;
        if (!sameAccount()) return;
        const detail = result.value;
        if (!detail || String(detail.teamId) !== String(account.teamId)) return;
        captureSource('team_info',detail);
        const info = targetAccount ? {vipLevel:detail?.subscriptionInfo?.curLevel,expireTime:detail?.subscriptionInfo?.vipEndTime} : feature._membershipService?.snapshot?.team;
        if (!info) return;
        subscription = { membershipPlan: ({teams:'高级团队会员',teams_super:'超级团队会员'})[info.vipLevel] || name(info.vipLevel) || null,
          billingCycle:null, membershipExpiresAt:iso(info.expireTime), nextRenewalAt:null, subscriptionObservedAt:timestamp() };
        const teamInfo=detail?.subscriptionInfo;
        if (teamInfo) subscriptionFacts=[{spaceType:'team',loginUserId:userId,teamId:rawId(account.teamId),
          readAt:subscription.subscriptionObservedAt,active:typeof teamInfo.flag==='boolean'?teamInfo.flag:null,
          planLevel:rawId(teamInfo.curLevel),productId:rawId(teamInfo.productId),subscribeCycle:rawCount(teamInfo.subscribeCycle),
          cycleUnit:rawId(teamInfo.cycleUnit),startTime:rawScalar(teamInfo.vipStartTime),endTime:rawScalar(teamInfo.vipEndTime),
          nextRenewalTime:rawScalar(teamInfo.nextRenewalTime)}];
        const members = new Map(); let membersComplete = false; let memberCursor = '0';
        try {
          for (let page = 0; page < 5; page++) {
            let response;
            if (scopedRead) {
              const read = await withTimeout(scopedRead('/commerce/v3/teamwork/get_team_member_list',{team_id:String(detail.teamId),count:50,...(memberCursor==='0'?{}:{cursor:memberCursor})}));
              response = read?.ok ? {ok:true,value:{list:read.value.teamMemberList,hasMore:read.value.hasMore,nextCursor:read.value.nextCursor,total:read.value.memberCnt}} : read;
            } else response = await withTimeout(workspace.refreshMembers({teamId:detail.teamId,cursor:memberCursor,count:50}));
            if (!sameAccount()) return;
            if (!response?.ok || !Array.isArray(response.value?.list)) break;
            if (!scopedRead) captureSource('team_member_list',response.value,{cursor:memberCursor});
            let valid = true;
            for (const member of response.value.list) {
              if (!member.userId) { valid = false; continue; }
              if (member.status && member.status !== 'Active') continue;
              members.set(String(member.userId), {platformUserId:String(member.userId),displayName:name(member.nickname),
                role:({Owner:'creator',Admin:'admin',Collaborator:'member'})[member.role] || 'unknown',
                usedCredits:amount(member.userCredits?.consumedCredits),balance:amount(member.userCredits?.remainCredits),joinedAt:iso(member.joinTime)});
            }
            if (response.value.hasMore === false) { membersComplete = valid && (amount(response.value.total) === null || members.size === response.value.total); break; }
            if (!valid || !response.value.nextCursor || response.value.nextCursor === memberCursor) break;
            memberCursor = response.value.nextCursor;
          }
        } catch { /* Partial member lists are explicitly incomplete, never fabricated from screenshots. */ }
        const creator = [...members.values()].find(member => member.role === 'creator');
        const creatorId = creator?.platformUserId || detail.ownerUserId || detail.creatorUserId;
        const totalSeats = amount(detail.memberLimit), usedSeats = amount(detail.memberCnt);
        teamSnapshot = {spaceId:String(detail.teamId),name:name(detail.teamName),
          creatorPlatformUserId:creatorId == null ? null : String(creatorId),creatorDisplayName:creator?.displayName || null,
          membershipPlan:subscription.membershipPlan,membershipExpiresAt:subscription.membershipExpiresAt,
          ...(pool ? {totalBalance:pool.balance,allocatableBalance:pool.allocatableBalance} : {}),
          totalSeats,availableSeats:totalSeats !== null && usedSeats !== null && usedSeats <= totalSeats ? totalSeats-usedSeats : null,
          membersComplete,members:[...members.values()],observedAt:timestamp()};
      } else {
        const vipApi = resolve('dreamina-vip-data-service');
        const env = resolve('environment-service');
        const aid = Number(env?.appId);
        if (!Number.isFinite(aid)) return;
        const result = await withTimeout(scopedRead ? scopedRead('/commerce/v1/subscription/user_info',{aid,scene:'vip',need_sign_info:true}) : vipApi.fetchVIPInfo({aid,scene:'vip',needSignInfo:true}));
        if (!result?.ok || !result.value) return;
        if (!scopedRead) captureSource('user_info',result.value);
        const info = result.value, plan = info.currentAutoRenewPlan || info.autoRenewPlans?.find(item=>item.canCancel===true);
        let cycle = null;
        if (plan?.status === 'SUBSCRIBED' && plan.level === info.curVipLevel) {
          if (plan.cycleUnit === 'YEAR' || (plan.cycleUnit === 'MONTH' && plan.cycle === 12)) cycle = '连续包年';
          else if (plan.cycleUnit === 'MONTH' && plan.cycle === 3) cycle = '连续包季';
          else if (plan.cycleUnit === 'MONTH' && plan.cycle === 1) cycle = '连续包月';
        }
        subscription = { membershipPlan:info.flag ? ({ultra:'超级会员',maestro:'高级会员',artisan:'标准会员',standard:'基础会员'})[info.curVipLevel] || name(info.curVipLevel) || null : '无有效个人会员',
          billingCycle:cycle, membershipExpiresAt:iso(info.endTime), nextRenewalAt:cycle ? iso(plan.nextRenewalTime) : null, subscriptionObservedAt:timestamp() };
        subscriptionFacts=[{spaceType:'personal',loginUserId:userId,teamId:null,readAt:subscription.subscriptionObservedAt,
          active:typeof info.flag==='boolean'?info.flag:null,planLevel:rawId(info.curVipLevel),productId:rawId(info.productId),
          subscribeCycle:rawCount(info.subscribeCycle),cycleUnit:rawId(info.cycleUnit),startTime:rawScalar(info.startTime),
          endTime:rawScalar(info.endTime),nextRenewalTime:rawScalar(info.nextRenewalTime)}];
      }
    } catch { /* Membership failure does not replace known membership or invalidate fresh credit. */ }
  };
  const records = [];
  try {
    const results = await Promise.allSettled([
      withTimeout(api.fetchUserCredit(undefined, team ? {queryScope:'team_member'} : undefined)),
      ...(poolAccess ? [withTimeout(api.fetchUserCredit(undefined, {queryScope:'team_all'}))] : []),
    ]);
    own = results[0]?.status === 'fulfilled' ? readBalance(results[0].value) : null;
    pool = results[1]?.status === 'fulfilled' ? readBalance(results[1].value) : null;
    if (!sameAccount()) return changed();
    if (!scopedRead) {
      if (results[0]?.status==='fulfilled' && results[0].value?.ok) captureSource('user_credit',results[0].value.value,{queryScope:team?'team_member':'personal'});
      if (results[1]?.status==='fulfilled' && results[1].value?.ok) captureSource('user_credit',results[1].value.value,{queryScope:'team_total'});
    }
    await readSubscription();
    if (!sameAccount()) return changed();
    const watermark = previousAccount === collectionKey ? previousEventId : null;
    for (let page = 0; page < 5; page++) {
      const result = await withTimeout(api.fetchUserCreditHistory(undefined, {
        count:20, cursor, ...(team ? {queryScope:poolAccess?'team_all':'team_member'} : {}),
      }));
      if (!sameAccount()) return changed();
      if (!result?.ok || !Array.isArray(result.value?.records)) { historyError = true; break; }
      const value = result.value;
      if (!scopedRead) captureSource('user_credit_history',value,{cursor,queryScope:ledgerScope});
      if (page === 0 && cursor === '0') headEventId = rawId(value.records[0]?.historyId);
      records.push(...value.records);
      hasMore = value.hasMore === true;
      if (!hasMore || (watermark && value.records.some(r => rawId(r?.historyId) === watermark))) { nextCursor = null; hasMore = false; break; }
      if (!value.newCursor || value.newCursor === cursor) { historyError = true; break; }
      cursor = value.newCursor;
      nextCursor = cursor;
    }
  } catch { historyError = true; }
  if (!sameAccount()) return changed();
  if (!own && !pool && !records.length) return identityOnly('余额接口未返回有效数据，下次自动重试','credit_balance_unavailable');
  const message = !own && !pool ? '流水已取得；余额下次继续读取' : historyError ? '余额已同步；部分流水暂未取得，下次使用时重试' :
    poolAccess && !pool ? '成员余额已同步，团队总额暂未更新，保留上次记录' :
    hasMore ? '正在分批补齐平台流水；统计仅覆盖已取得的记录' : '已同步当前账号与平台返回的积分流水';
  if (historyError) nextCursor = cursor;
  const keepWatermark = historyError || nextCursor;
  return {
    observedAt:timestamp(), status:'ok', message, collectionKey,
    diagnosticCodes:[...(historyError ? ['credit_history_partial'] : []),...((poolAccess && !pool) || (!own && !pool) ? ['credit_balance_unavailable'] : []),
      ...(sourceCapturePartial ? ['source_capture_partial'] : [])],
    partial:historyError || sourceCapturePartial || Boolean(nextCursor) || !own || (poolAccess && !pool) || !subscription || (team && (!teamSnapshot || !teamSnapshot.membersComplete)),
    headEventId:keepWatermark ? (continuing ? previousEventId : null) : headEventId,
    nextCursor, pendingHeadEventId:keepWatermark ? headEventId : null,
    ...(subscription || {}),
    ...(subscriptionFacts.length ? {subscriptionFacts} : {}),
    ...(creditSourceFacts.length ? {creditSourceFacts} : {}),
    ...(sourceCapturePartial ? {sourceCapturePartial:true} : {}),
    ...(teamSnapshot ? {teamSnapshot} : {}),
    userId, displayName:name(user.userProfile?.name)||'即梦账号', accountType:account.accountType,
    teamId:account.teamId == null ? null : String(account.teamId), teamName:name(account.displayInfo?.teamName),
    balanceFresh:!!own, balance:own?.balance??null, giftCredit:own?.giftCredit??null,
    purchaseCredit:own?.purchaseCredit??null, vipCredit:own?.vipCredit??null, expiresAt:own?.expiresAt??null,
    ...(own ? {creditBatches:own.creditBatches,creditBatchesComplete:own.creditBatchesComplete} : {}),
    canReadTeamTotal:!!pool, teamTotalCredit:pool?.balance??null, teamGiftCredit:pool?.giftCredit??null,
    teamPurchaseCredit:pool?.purchaseCredit??null, teamVipCredit:pool?.vipCredit??null, teamExpiresAt:pool?.expiresAt??null,
    ...(pool ? {teamCreditBatches:pool.creditBatches,teamCreditBatchesComplete:pool.creditBatchesComplete} : {}),
    ledgerScope,
    records:records.slice(0,100).map(r=>({
      historyId:rawId(r?.historyId), submitId:rawId(r?.submitId), amount:rawScalar(r?.amount), title:name(r?.title),
      historyType:rawScalar(r?.historyType), createTime:rawScalar(r?.createTime), status:name(r?.status),
      teamId:rawId(r?.teamId),
      userId:rawId(r?.userId ?? r?.groupUserInfo?.uid),
    })),
  };
}
