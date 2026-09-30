import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (message, status = 400) => { throw new HttpError(status, message); };
export const hash = value => createHash('sha256').update(value).digest('hex');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function shape(value, allowed, label = '数据') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}包含不支持的字段：${key}`);
  return value;
}
export function string(value, label, max = 120, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}格式不正确`);
  if (/(?:cookie|sessionid|sid_tt|authorization|bearer|password|api[_-]?key)\s*[:=]/i.test(value)) fail(`${label}不得包含登录凭据`);
  return value.trim();
}
export function identifier(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !/^[\w.@:-]{1,160}$/.test(value)) fail(`${label}格式不正确`);
  return value;
}
export function iso(value, label, now, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label}必须是 ISO 时间`);
  const result = new Date(value).toISOString();
  if (now !== undefined && Date.parse(result) > now + 300_000) fail(`${label}不能晚于当前时间`);
  return result;
}
export function number(value, label, optional = true) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) fail(`${label}必须是有效数值`);
  return value;
}
const diagnosticCodes=new Set(['collector_started','collection_started','collection_completed','collection_partial','collection_failed','upload_failed','upload_recovered','connection_failed','connection_recovered','configuration_invalid','command_failed','operation_saved','operation_uploaded','operation_upload_failed','operation_rejected','operation_save_failed','operation_queue_full','operation_bridge_full']);
for (const code of ['page_not_ready','page_login_required','account_context_changed','credit_api_unavailable','credit_balance_unavailable','credit_history_partial','team_discovery_partial','account_read_recovered','source_capture_partial']) diagnosticCodes.add(code);
export function validateDiagnostics(input,now) {
  shape(input,['logs'],'排障日志');
  if(!Array.isArray(input.logs)||input.logs.length>50)fail('每次最多上报 50 条排障日志');
  return input.logs.map(item=>{
    shape(item,['id','at','code','httpStatus','readTabs','skippedTabs','pendingCount','extensionVersion'],'排障日志');
    if(typeof item.id!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(item.id))fail('日志标识格式不正确');
    if(!diagnosticCodes.has(item.code))fail('日志类型不正确');
    const result={id:item.id,at:iso(item.at,'日志时间',now),code:item.code};
    if(item.extensionVersion!==undefined){
      if(typeof item.extensionVersion!=='string'||!/^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(item.extensionVersion))fail('插件版本格式不正确');
      result.extensionVersion=item.extensionVersion;
    }
    for(const [key,min,max] of [['httpStatus',100,599],['readTabs',0,100],['skippedTabs',0,100],['pendingCount',0,10000]]){
      if(item[key]===undefined)continue;
      if(!Number.isInteger(item[key])||item[key]<min||item[key]>max)fail('日志统计值格式不正确');
      result[key]=item[key];
    }
    return result;
  });
}
export function identity(value) {
  const platformUserId = identifier(value.platformUserId, '平台用户 ID');
  const scope = value.scope;
  if (!['personal', 'team_total', 'team_member'].includes(scope)) fail('积分范围不正确');
  const spaceId = scope === 'personal' ? identifier(value.spaceId, '空间 ID', true) : identifier(value.spaceId, '团队空间 ID');
  const spaceType = scope === 'personal' ? 'personal' : 'team';
  if (value.spaceType !== undefined && value.spaceType !== spaceType) fail('空间类型与积分范围不一致');
  const parts = scope === 'personal' ? [scope, platformUserId] : scope === 'team_total' ? [scope, spaceId] : [scope, spaceId, platformUserId];
  return { id: `${scope}_${hash(JSON.stringify(parts)).slice(0, 32)}`, platformUserId, spaceId, spaceType, scope };
}
export function transactionId(account, eventId) {
  // A member and an administrator may observe the same team event.
  const ledger = account.spaceType === 'team' ? ['team', account.spaceId] : ['personal', account.platformUserId];
  return `tx_${hash(JSON.stringify([...ledger, eventId]))}`;
}
const accountKeys = ['platformUserId', 'spaceId', 'spaceType', 'scope', 'displayName', 'spaceName', 'balance', 'giftBalance', 'purchaseBalance', 'subscriptionBalance', 'expiresAt', 'lastSyncedAt', 'membershipPlan', 'billingCycle', 'membershipExpiresAt', 'nextRenewalAt', 'subscriptionObservedAt', 'creditBatches', 'creditBatchesComplete'];
const transactionKeys = ['platformUserId', 'spaceId', 'scope', 'eventId', 'occurredAt', 'kind', 'amount', 'description', 'chargedPlatformUserId', 'platformSubmitId'];
const creditHistoryFactKeys = ['historyId', 'historyType', 'amount', 'title', 'createTime', 'status', 'teamId', 'userId', 'submitId'];
const subscriptionFactKeys = ['spaceType', 'loginUserId', 'teamId', 'readAt', 'active', 'planLevel', 'productId', 'subscribeCycle', 'cycleUnit', 'startTime', 'endTime', 'nextRenewalTime'];
const creditSourceNames = new Set(['user_credit', 'user_credit_history', 'user_info', 'team_info', 'team_member_list']);
const blockedSourceKey = /authorization|cookie|session|password|passwd|token|secret|authkey|apikey|privatekey|signature|csrf|signinfo|credential|captcha|ticket|prompt|image|video|avatar|cover|media|fileurl|asseturl|downloadurl/;
const credentialValue = /(?:cookie|sessionid|sid_tt|authorization|bearer|password|api[_-]?key|access_token|refresh_token|authkey)\s*[:=]|https?:\/\/|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/i;
function validateCreditSourcePayload(payload) {
  if (payload === null || typeof payload !== 'object') fail('平台响应摘要必须是对象或列表');
  let nodes = 0;
  const walk = (value, depth) => {
    // A source wrapper and nested platform records each add a level.
    if (++nodes > 5000 || depth > 8) fail('平台响应摘要层级过深');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > 1e16) fail('平台响应摘要数值不正确');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > 1000 || /[\u0000-\u001f\u007f]/u.test(value) || credentialValue.test(value)) fail('平台响应摘要文字不安全');
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 200) fail('平台响应摘要列表过长');
      return value.map(item => walk(item, depth + 1));
    }
    if (!value || typeof value !== 'object' || Object.keys(value).length > 100) fail('平台响应摘要对象过大');
    const entries = Object.entries(value).map(([key,item]) => {
      const normalized = key.replace(/[^a-z]/gi,'').toLowerCase();
      if (!key || key.length > 100 || /[\u0000-\u001f\u007f]/u.test(key) ||
          ['__proto__','prototype','constructor'].includes(key) || blockedSourceKey.test(normalized)) fail('平台响应摘要含不允许的字段');
      return [key,walk(item,depth + 1)];
    });
    return Object.fromEntries(entries);
  };
  const result = walk(payload, 0);
  if (Buffer.byteLength(JSON.stringify(result),'utf8') > 128 * 1024) fail('单条平台响应摘要过大');
  return result;
}
const teamKeys = ['spaceId', 'name', 'creatorPlatformUserId', 'creatorDisplayName', 'membershipPlan', 'membershipExpiresAt', 'totalBalance', 'allocatableBalance', 'totalSeats', 'availableSeats', 'membersComplete', 'members', 'observedAt'];
const teamMemberKeys = ['platformUserId', 'displayName', 'role', 'usedCredits', 'balance', 'joinedAt'];
function nonNegativeNumber(value, label, integer = false) {
  const result = number(value, label);
  if (result !== null && (result < 0 || (integer && !Number.isSafeInteger(result)))) fail(`${label}必须是非负${integer ? '整数' : '数值'}`);
  return result;
}
function nullableIdentifier(value, label) {
  return value === null ? null : identifier(value, label);
}
function validateTeam(item, envelopeObservedAt, now) {
  shape(item, teamKeys, '团队快照');
  const result = { spaceId:identifier(item.spaceId, '团队空间 ID') };
  result.observedAt = item.observedAt === undefined ? envelopeObservedAt : iso(item.observedAt, '团队采集时间', now);
  if (result.observedAt > envelopeObservedAt) fail('团队采集时间不能晚于本次采集时间');
  result.membersComplete = item.membersComplete === undefined ? false : item.membersComplete;
  if (typeof result.membersComplete !== 'boolean') fail('成员列表完整标记必须是布尔值');
  if (result.membersComplete && !own(item, 'members')) fail('完整团队快照必须提供成员列表');
  const members = item.members === undefined ? [] : item.members;
  if (!Array.isArray(members) || members.length > 500) fail('每个团队的成员列表不得超过 500 条');
  const seen = new Set();
  result.members = members.map(member => {
    shape(member, teamMemberKeys, '团队成员');
    const data = { platformUserId:identifier(member.platformUserId, '成员平台用户 ID') };
    if (seen.has(data.platformUserId)) fail('同一团队快照不得重复提供同一成员');
    seen.add(data.platformUserId);
    if (own(member, 'displayName')) data.displayName = string(member.displayName, '成员显示名称', 100);
    if (own(member, 'role')) {
      if (!['creator', 'admin', 'member', 'unknown'].includes(member.role)) fail('团队成员角色不正确');
      data.role = member.role;
    }
    if (own(member, 'usedCredits')) data.usedCredits = nonNegativeNumber(member.usedCredits, '成员消耗积分');
    if (own(member, 'balance')) data.balance = nonNegativeNumber(member.balance, '成员剩余额度');
    if (own(member, 'joinedAt')) data.joinedAt = iso(member.joinedAt, '加入团队时间', now, true);
    return data;
  });
  if (own(item, 'name')) result.name = string(item.name, '团队名称', 100);
  if (own(item, 'creatorPlatformUserId')) result.creatorPlatformUserId = nullableIdentifier(item.creatorPlatformUserId, '创建者平台用户 ID');
  if (own(item, 'creatorDisplayName')) result.creatorDisplayName = string(item.creatorDisplayName, '创建者显示名称', 100, true);
  if (own(item, 'membershipPlan')) result.membershipPlan = string(item.membershipPlan, '团队会员方案', 100, true);
  if (own(item, 'membershipExpiresAt')) result.membershipExpiresAt = iso(item.membershipExpiresAt, '团队会员有效期', undefined, true);
  for (const field of ['totalBalance', 'allocatableBalance']) if (own(item, field)) result[field] = nonNegativeNumber(item[field], field === 'totalBalance' ? '团队总余额' : '可分配积分');
  for (const field of ['totalSeats', 'availableSeats']) if (own(item, field)) result[field] = nonNegativeNumber(item[field], field === 'totalSeats' ? '总席位数' : '空余席位数', true);
  if (result.totalSeats != null && result.availableSeats != null && result.availableSeats > result.totalSeats) fail('空余席位不能超过总席位');
  return result;
}
export function validateIngest(input, now) {
  shape(input, ['observedAt', 'accounts', 'transactions', 'teams', 'status', 'message', 'loginIdentity', 'operationEvidence', 'creditHistoryFacts', 'subscriptionFacts', 'creditSourceFacts'], '采集数据');
  const observedAt = iso(input.observedAt, '采集时间', now);
  if (!Array.isArray(input.accounts) || input.accounts.length > 100) fail('账号列表不得超过 100 条');
  if (!Array.isArray(input.transactions) || input.transactions.length > 1000) fail('流水列表不得超过 1000 条');
  const factInputs = input.creditHistoryFacts === undefined ? [] : input.creditHistoryFacts;
  if (!Array.isArray(factInputs) || factInputs.length > 30) fail('积分事实批次不得超过 30 组');
  const factId = (value, label) => value == null || value === '' ? null
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : string(value, label, 160);
  const factScalar = (value, label, max = 64) => value == null || value === '' ? null
    : typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e16 ? value
    : string(value, label, max);
  let rejectedFacts = 0;
  const creditHistoryFacts = [];
  for (const group of factInputs) {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.records) || group.records.length > 100) fail('积分事实每组不得超过 100 条');
    let context;
    try {
      shape(group, ['context', 'records'], '积分事实组');
      shape(group.context, ['loginUserId', 'queryScope', 'teamId', 'readAt'], '积分事实来源');
      const queryScope = group.context.queryScope;
      if (!['personal', 'team_member', 'team_total'].includes(queryScope)) fail('积分事实查询范围不正确');
      const loginUserId = identifier(group.context.loginUserId, '积分事实登录账号 ID');
      const teamId = group.context.teamId == null ? null : identifier(group.context.teamId, '积分事实团队 ID');
      if ((queryScope === 'personal') !== (teamId === null)) fail('积分事实查询范围与团队 ID 不一致');
      context = { loginUserId, queryScope, teamId, readAt:iso(group.context.readAt, '积分事实采集时间', now) };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      rejectedFacts += group.records.length;
      continue;
    }
    const records = [];
    for (const item of group.records) {
      try {
        shape(item, creditHistoryFactKeys, '积分事实');
        const record = {
          historyId:factId(item.historyId, '平台流水 ID'), historyType:factScalar(item.historyType, '平台流水类型'),
          amount:factScalar(item.amount, '平台积分数值'), title:string(item.title, '平台流水标题', 160, true),
          createTime:factScalar(item.createTime, '平台流水时间'), status:string(item.status, '平台流水状态', 80, true),
          teamId:factId(item.teamId, '平台流水团队 ID'), userId:factId(item.userId, '平台流水用户 ID'),
          submitId:factId(item.submitId, '平台提交 ID'),
        };
        if (Object.values(record).every(value => value === null)) fail('积分事实没有可用字段');
        records.push(record);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        rejectedFacts++;
      }
    }
    if (records.length) creditHistoryFacts.push({context, records});
  }
  const subscriptionInputs = input.subscriptionFacts === undefined ? [] : input.subscriptionFacts;
  if (!Array.isArray(subscriptionInputs) || subscriptionInputs.length > 30) fail('订阅事实不得超过 30 条');
  let rejectedSubscriptionFacts = 0;
  const subscriptionFacts = [];
  for (const item of subscriptionInputs) {
    try {
      shape(item, subscriptionFactKeys, '订阅事实');
      if (!['personal', 'team'].includes(item.spaceType)) fail('订阅空间类型不正确');
      const teamId = item.teamId == null ? null : identifier(item.teamId, '订阅团队 ID');
      if ((item.spaceType === 'personal') !== (teamId === null)) fail('订阅空间类型与团队 ID 不一致');
      if (item.active != null && typeof item.active !== 'boolean') fail('订阅有效状态必须是布尔值');
      subscriptionFacts.push({
        spaceType:item.spaceType,loginUserId:identifier(item.loginUserId,'订阅登录账号 ID'),teamId,
        readAt:iso(item.readAt,'订阅事实采集时间',now),active:item.active??null,
        planLevel:factScalar(item.planLevel,'订阅等级'),productId:factId(item.productId,'订阅商品 ID'),
        subscribeCycle:factScalar(item.subscribeCycle,'订阅周期'),cycleUnit:factScalar(item.cycleUnit,'订阅周期单位'),
        startTime:factScalar(item.startTime,'订阅开始时间'),endTime:factScalar(item.endTime,'订阅结束时间'),
        nextRenewalTime:factScalar(item.nextRenewalTime,'订阅下次续费时间'),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      rejectedSubscriptionFacts++;
    }
  }
  const sourceInputs = input.creditSourceFacts === undefined ? [] : input.creditSourceFacts;
  if (!Array.isArray(sourceInputs) || sourceInputs.length > 16) fail('平台响应摘要不得超过 16 条');
  let rejectedCreditSourceFacts = 0;
  const creditSourceFacts = [];
  for (const item of sourceInputs) {
    try {
      shape(item, ['source','loginUserId','teamId','queryScope','readAt','payload'], '平台响应摘要');
      if (!creditSourceNames.has(item.source)) fail('平台响应来源不正确');
      if (!['personal','team_member','team_total'].includes(item.queryScope)) fail('平台响应查询范围不正确');
      const teamId = item.teamId == null ? null : identifier(item.teamId, '平台响应团队 ID');
      if ((item.queryScope === 'personal') !== (teamId === null)) fail('平台响应查询范围与团队 ID 不一致');
      creditSourceFacts.push({source:item.source,loginUserId:identifier(item.loginUserId,'平台响应登录账号 ID'),
        teamId,queryScope:item.queryScope,readAt:iso(item.readAt,'平台响应采集时间',now),
        payload:validateCreditSourcePayload(item.payload)});
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      rejectedCreditSourceFacts++;
    }
  }
  const teamInputs = input.teams === undefined ? [] : input.teams;
  if (!Array.isArray(teamInputs) || teamInputs.length > 100) fail('团队列表不得超过 100 条');
  const teams = teamInputs.map(item => validateTeam(item, observedAt, now));
  const status = input.status ?? 'ok';
  if (!['ok', 'login_required', 'error'].includes(status)) fail('采集状态不正确');
  const evidenceInputs = input.operationEvidence === undefined ? [] : input.operationEvidence;
  if (!Array.isArray(evidenceInputs) || evidenceInputs.length > 100) fail('提交操作证据不得超过 100 条');
  if (evidenceInputs.length && status !== 'ok') fail('未确认提交成功，不能提供操作证据');
  const operationEvidence = evidenceInputs.map(item => {
    shape(item, ['submitId', 'userId', 'spaceType', 'spaceId', 'occurredAt'], '提交操作证据');
    const submitId = identifier(item.submitId, '平台提交 ID'), userId = identifier(item.userId, '提交平台用户 ID');
    if (!['personal', 'team'].includes(item.spaceType)) fail('提交空间类型不正确');
    let spaceId;
    if (item.spaceType === 'personal') {
      if (![undefined, null, '', '0', 'personal'].includes(item.spaceId)) fail('个人提交空间 ID 不正确');
      spaceId = 'personal';
    } else {
      spaceId = identifier(item.spaceId, '提交团队空间 ID');
      if (spaceId === userId) fail('团队空间 ID 不能作为提交用户 ID');
    }
    return { submitId, userId, spaceType:item.spaceType, spaceId, occurredAt:iso(item.occurredAt, '提交操作时间', now) };
  });
  let loginIdentity;
  if(own(input,'loginIdentity')){
    if(status!=='ok')fail('未确认登录状态，不能提供登录身份');
    shape(input.loginIdentity,['platformUserId','displayName'],'登录身份');
    const platformUserId=identifier(input.loginIdentity.platformUserId,'登录平台用户 ID');
    loginIdentity={platformUserId,displayName:string(input.loginIdentity.displayName,'登录昵称',100,true)??platformUserId};
  }
  const accounts = input.accounts.map(item => {
    shape(item, accountKeys, '账号');
    const account = identity(item);
    const lastSyncedAt = item.lastSyncedAt === undefined ? observedAt : iso(item.lastSyncedAt, '账号采集时间', now);
    if (lastSyncedAt > observedAt) fail('账号采集时间不能晚于本次采集时间');
    const subscription = {};
    if(own(item,'creditBatches')){
      if(item.creditBatches!==null&&(!Array.isArray(item.creditBatches)||item.creditBatches.length>200))fail('积分批次不得超过 200 条');
      subscription.creditBatches=item.creditBatches===null?null:item.creditBatches.map(batch=>{
        shape(batch,['kind','amount','expiresAt'],'积分批次');
        if(!['subscription','gift','purchase'].includes(batch.kind))fail('积分批次类型不正确');
        const amount=number(batch.amount,'批次剩余积分',false);if(amount<=0)fail('批次剩余积分必须大于零');
        return {kind:batch.kind,amount,expiresAt:iso(batch.expiresAt,'积分到期时间',undefined,true)};
      });
    }
    if(own(item,'creditBatchesComplete')){
      if(typeof item.creditBatchesComplete!=='boolean')fail('积分批次完整标记必须是布尔值');
      if(item.creditBatchesComplete&&!Array.isArray(subscription.creditBatches))fail('完整积分批次必须提供列表');
      subscription.creditBatchesComplete=item.creditBatchesComplete;
    }
    if (own(item, 'membershipPlan')) subscription.membershipPlan = string(item.membershipPlan, '会员方案', 100, true);
    if (own(item, 'billingCycle')) subscription.billingCycle = string(item.billingCycle, '会员计费周期', 50, true);
    if (own(item, 'membershipExpiresAt')) subscription.membershipExpiresAt = iso(item.membershipExpiresAt, '会员有效期', undefined, true);
    if (own(item, 'nextRenewalAt')) subscription.nextRenewalAt = iso(item.nextRenewalAt, '下次续费时间', undefined, true);
    if (own(item, 'subscriptionObservedAt')) {
      subscription.subscriptionObservedAt = iso(item.subscriptionObservedAt, '会员信息采集时间', now, true);
      if (subscription.subscriptionObservedAt && subscription.subscriptionObservedAt > observedAt) fail('会员信息采集时间不能晚于本次采集时间');
    }
    return { ...account, displayName: string(item.displayName, '账号名称', 100, true) ?? account.platformUserId,
      spaceName: string(item.spaceName, '空间名称', 100, true) ?? (account.spaceType === 'personal' ? '个人空间' : '团队空间'),
      balance: number(item.balance, '余额'), giftBalance: number(item.giftBalance, '赠送积分'),
      purchaseBalance: number(item.purchaseBalance, '充值积分'), subscriptionBalance: number(item.subscriptionBalance, '订阅积分'),
      expiresAt: iso(item.expiresAt, '到期时间', undefined, true), lastSyncedAt, ...subscription };
  });
  if(loginIdentity){
    if(accounts.some(account=>account.scope!=='team_total'&&account.platformUserId!==loginIdentity.platformUserId))fail('登录身份与个人或成员钱包身份不一致');
    if(teams.some(team=>team.spaceId===loginIdentity.platformUserId)||accounts.some(account=>account.spaceType==='team'&&account.spaceId===loginIdentity.platformUserId))fail('团队空间 ID 不能作为登录身份');
  }
  const transactions = input.transactions.map(item => {
    shape(item, transactionKeys, '流水');
    const account = identity(item), eventId = identifier(item.eventId, '流水 ID');
    const suppliedChargedId = item.chargedPlatformUserId === null || item.chargedPlatformUserId === undefined
      ? null : identifier(item.chargedPlatformUserId, '扣费平台成员 ID');
    if (account.scope !== 'team_total' && own(item, 'chargedPlatformUserId') && suppliedChargedId !== account.platformUserId) fail('扣费平台成员 ID 与个人或成员账本身份不一致');
    const chargedPlatformUserId = account.scope === 'team_total' ? suppliedChargedId : account.platformUserId;
    const kind = item.kind;
    if (!['consume', 'refund', 'grant', 'expire', 'adjustment'].includes(kind)) fail('流水类型不正确');
    const amount = number(item.amount, '流水积分', false);
    if (amount === 0 || (['consume', 'expire'].includes(kind) && amount > 0) || (['refund', 'grant'].includes(kind) && amount < 0)) fail('流水积分正负号与类型不一致');
    return { id: transactionId(account, eventId), eventId, accountId: account.id, account, chargedPlatformUserId,
      platformSubmitId:item.platformSubmitId == null ? null : identifier(item.platformSubmitId, '流水平台提交 ID'),
      occurredAt: iso(item.occurredAt, '流水发生时间', now), kind, amount,
      description: string(item.description, '流水说明', 160, true) ?? ({consume:'生成扣费',refund:'积分返还',grant:'积分到账',expire:'积分过期',adjustment:'积分调整'}[kind]) };
  });
  return { observedAt, accounts, transactions, teams, status, message: string(input.message, '采集说明', 240, true),...(loginIdentity?{loginIdentity}:{}),...(own(input,'operationEvidence')?{operationEvidence}:{}),
    ...(own(input,'creditHistoryFacts')?{creditHistoryFacts,rejectedFacts}:{}),
    ...(own(input,'subscriptionFacts')?{subscriptionFacts,rejectedSubscriptionFacts}:{}),
    ...(own(input,'creditSourceFacts')?{creditSourceFacts,rejectedCreditSourceFacts}:{}) };
}
export function validateInstallation(input, patch = false) {
  shape(input, patch ? ['employeeId', 'role', 'enabled'] : ['employeeId', 'role'], '设备配置');
  const result = {};
  if(!patch||own(input,'employeeId'))result.employeeId=patch&&input.employeeId===null?null:identifier(input.employeeId,'员工 ID');
  if (!patch || own(input, 'role')) {
    if (input.role !== undefined && input.role !== 'collector') fail('采集端仅用于员工采集');
    result.role = 'collector';
  }
  if (own(input, 'enabled')) { if (typeof input.enabled !== 'boolean') fail('启用状态不正确'); result.enabled = input.enabled; }
  if (!Object.keys(result).length) fail('没有可修改的字段');
  return result;
}

export function validateIdentityMapping(input) {
  shape(input, ['employeeId', 'boundPhone'], '账号归属');
  const result = {};
  if(own(input,'employeeId'))result.employeeId=nullableIdentifier(input.employeeId,'员工 ID');
  if(own(input,'boundPhone')){
    const phone=string(input.boundPhone,'绑定手机号',32,true);
    result.boundPhone=phone?.normalize('NFKC').replace(/[\s()-]/g,'')??null;
    if(result.boundPhone&&!/^\+?[\d*]{7,20}$/.test(result.boundPhone))fail('绑定手机号格式不正确');
  }
  if(!Object.keys(result).length)fail('没有可修改的字段');
  return result;
}

export function validateDepartment(input) {
  shape(input,['name'],'部门');
  return {name:string(typeof input.name==='string'?input.name.trim():input.name,'部门名称',80)};
}
export function validateEmployee(input,patch=false) {
  shape(input,['name','departmentId'],'员工');
  const result={};
  if(!patch||own(input,'name'))result.name=string(typeof input.name==='string'?input.name.trim():input.name,'员工姓名',100);
  if(!patch||own(input,'departmentId'))result.departmentId=nullableIdentifier(input.departmentId,'部门 ID');
  if(!Object.keys(result).length)fail('没有可修改的字段');
  return result;
}
export function validateAccountOwnership(input) {
  shape(input,['ownerEmployeeId','ownerDepartmentId'],'账号归属');
  if(!Object.keys(input).length)fail('没有可修改的字段');
  return Object.fromEntries(Object.entries(input).map(([key,value])=>[key,nullableIdentifier(value,key==='ownerEmployeeId'?'员工 ID':'部门 ID')]));
}

export function validateCommandResult(input) {
  shape(input, ['status', 'message'], '刷新命令回执');
  if (!['completed', 'partial', 'failed', 'no_open_tabs'].includes(input.status)) fail('刷新结果状态不正确');
  return {status:input.status,message:string(input.message,'刷新结果说明',160,true)};
}
