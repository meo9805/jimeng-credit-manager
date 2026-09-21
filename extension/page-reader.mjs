// Chrome serializes this function into the page's MAIN world. Keep it self-contained.
// Use the page's read-only credit service; never open panels, change login, or export credentials.
export async function readJimengPage({ previousAccount = null, previousEventId = null, previousCursor = null, pendingHeadEventId = null, collectAllSpaces = false, previousCollections = {}, targetAccount = null } = {}) {
  const timestamp = () => new Date().toISOString();
  const fail = (status, message) => ({ observedAt: timestamp(), status, message });
  if (location.origin !== 'https://jimeng.jianying.com') return fail('error', '非即梦页面');
  const feature = window.__debugger?.DreaminaCommercialFeatureService;
  const credit = feature?.commercialCreditService || feature?._commercialCreditService;
  const port = feature?._commerceAccountPort;
  if (!credit || !port?.getSnapshot) return fail('error', '等待即梦页面就绪，或页面版本需要适配');
  const user = port.getSnapshot();
  if (!user?.hasLogin || !user.userId) return fail('login_required', '等待员工正常登录即梦');
  const identity = credit.getCurrentAccountSnapshot?.();
  const visibleAccount = identity?.account || credit.currentAccount || credit._currentAccount;
  if (!visibleAccount || !credit.isLocalCreditReady) return fail('error', '账号切换中，等待积分加载');
  const account = targetAccount || visibleAccount;
  const userId = String(user.userId), accountKey = account.accountKey;
  const team = account.accountType === 'team';
  const poolAccess = team && account.capability?.canAllocateTeamCredit === true;
  const ledgerScope = poolAccess ? 'team_total' : team ? 'team_member' : 'personal';
  const collectionKey = `${userId}:${accountKey}:${ledgerScope}`;
  const sameAccount = () => {
    const next = credit.getCurrentAccountSnapshot?.();
    const currentUser=port.getSnapshot();
    return credit.isLocalCreditReady && currentUser?.hasLogin && String(currentUser.userId) === userId &&
      (next?.account || credit.currentAccount || credit._currentAccount)?.accountKey === visibleAccount.accountKey &&
      (identity?.version === undefined || next?.version === identity.version);
  };
  const amount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const name = v => typeof v === 'string' ? v.slice(0, 100) : '';
  const identityOnly = message => {
    if(!sameAccount())return fail('error','账号已切换，已丢弃上一账号的采集结果');
    const continuing=previousAccount===collectionKey;
    return {observedAt:timestamp(),status:'ok',message,partial:true,collectionKey,
      userId,displayName:name(user.userProfile?.name)||'即梦账号',accountType:account.accountType,
      teamId:account.teamId==null?null:String(account.teamId),teamName:name(account.displayInfo?.teamName),
      balanceFresh:false,canReadTeamTotal:false,ledgerScope,records:[],
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
          if (detail.subscriptionInfo?.flag !== true) { if(detail.subscriptionInfo?.flag!==false)discoveryError=true; continue; }
          targets.push({accountType:'team',accountKey:`team:${detail.teamId}`,teamId:String(detail.teamId),
            displayInfo:{teamName:detail.teamName},capability:{canAllocateTeamCredit:detail.currentRole==='Owner'},detail});
        }
        if (result.value.hasMore === false) break;
        if (!result.value.nextCursor || result.value.nextCursor === cursor || page === 4) { discoveryError = true; break; }
        cursor = result.value.nextCursor;
      }
    } catch { discoveryError = true; }
    if (!sameAccount()) return fail('error','账号已切换，已丢弃上一账号的采集结果');
    const observations = [];
    for (const target of targets) {
      const scope = target.accountType==='personal' ? 'personal' : target.capability?.canAllocateTeamCredit ? 'team_total' : 'team_member';
      const key = `${userId}:${target.accountKey}:${scope}`, saved = previousCollections[key] || {};
      observations.push(await readJimengPage({targetAccount:target,previousAccount:key,previousEventId:saved.eventId,
        previousCursor:saved.cursor,pendingHeadEventId:saved.pendingHead}));
      if (!sameAccount()) return fail('error','账号已切换，已丢弃上一账号的采集结果');
    }
    return {status:'ok',observedAt:timestamp(),observations,partial:discoveryError || observations.some(x=>x.status!=='ok'||x.partial),
      message:discoveryError?'部分团队暂未发现，下次自动重试':'已同步个人与有效团队空间'};
  }
  let api;
  try {
    api = resolve('dreamina-credit-data-service');
  } catch { /* Unsupported page versions report unavailable instead of guessing a balance. */ }
  if (!api?.fetchUserCredit || !api?.fetchUserCreditHistory) return identityOnly('即梦积分接口需要适配，保留上次有效余额');
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
        const result = await client.post(repository._getApi(path),body,{timeout:8000});
        const payload = result?.data;
        return result.status===200 && String(payload?.ret)==='0' ? {ok:true,value:camel(payload.data)} : {ok:false};
      };
      api = {fetchUserCredit:(_,options)=>scopedRead('/commerce/v1/benefits/user_credit',options?.queryScope?{query_scope:options.queryScope}:{}),
        fetchUserCreditHistory:(_,options)=>scopedRead('/commerce/v1/benefits/user_credit_history',{
          count:options.count,cursor:options.cursor,...(options.queryScope?{query_scope:options.queryScope}:{})})};
    } catch { return identityOnly('跨空间积分接口需要适配，保留上次有效余额'); }
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
        const info = targetAccount ? {vipLevel:detail?.subscriptionInfo?.curLevel,expireTime:detail?.subscriptionInfo?.vipEndTime} : feature._membershipService?.snapshot?.team;
        if (!info) return;
        subscription = { membershipPlan: ({teams:'高级团队会员',teams_super:'超级团队会员'})[info.vipLevel] || name(info.vipLevel) || null,
          billingCycle:null, membershipExpiresAt:iso(info.expireTime), nextRenewalAt:null, subscriptionObservedAt:timestamp() };
        if (!detail || String(detail.teamId) !== String(account.teamId)) return;
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
        const info = result.value, plan = info.currentAutoRenewPlan || info.autoRenewPlans?.find(item=>item.canCancel===true);
        let cycle = null;
        if (plan?.status === 'SUBSCRIBED' && plan.level === info.curVipLevel) {
          if (plan.cycleUnit === 'YEAR' || (plan.cycleUnit === 'MONTH' && plan.cycle === 12)) cycle = '连续包年';
          else if (plan.cycleUnit === 'MONTH' && plan.cycle === 3) cycle = '连续包季';
          else if (plan.cycleUnit === 'MONTH' && plan.cycle === 1) cycle = '连续包月';
        }
        subscription = { membershipPlan:info.flag ? ({ultra:'超级会员',maestro:'高级会员',artisan:'标准会员',standard:'基础会员'})[info.curVipLevel] || name(info.curVipLevel) || null : '无有效个人会员',
          billingCycle:cycle, membershipExpiresAt:iso(info.endTime), nextRenewalAt:cycle ? iso(plan.nextRenewalTime) : null, subscriptionObservedAt:timestamp() };
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
    if (!sameAccount()) return fail('error', '账号已切换，已丢弃上一账号的采集结果');
    if (!own && !pool) return identityOnly('即梦余额暂未读取成功，保留上次余额与同步时间');
    await readSubscription();
    if (!sameAccount()) return fail('error', '账号已切换，已丢弃上一账号的采集结果');
    const watermark = previousAccount === collectionKey ? previousEventId : null;
    for (let page = 0; page < 5; page++) {
      const result = await withTimeout(api.fetchUserCreditHistory(undefined, {
        count:20, cursor, ...(team ? {queryScope:poolAccess?'team_all':'team_member'} : {}),
      }));
      if (!sameAccount()) return fail('error', '账号已切换，已丢弃上一账号的采集结果');
      if (!result?.ok || !Array.isArray(result.value?.records)) { historyError = true; break; }
      const value = result.value;
      if (page === 0 && cursor === '0') headEventId = value.records[0]?.historyId || null;
      records.push(...value.records);
      hasMore = value.hasMore === true;
      if (!hasMore || (watermark && value.records.some(r => r.historyId === watermark))) { nextCursor = null; hasMore = false; break; }
      if (!value.newCursor || value.newCursor === cursor) { historyError = true; break; }
      cursor = value.newCursor;
      nextCursor = cursor;
    }
  } catch { historyError = true; }
  if (!sameAccount()) return fail('error', '账号已切换，已丢弃上一账号的采集结果');
  if (!own && !pool) return identityOnly('即梦余额暂未读取成功，保留上次余额与同步时间');
  const message = historyError ? '余额已同步；部分流水暂未取得，下次使用时重试' :
    poolAccess && !pool ? '成员余额已同步，团队总额暂未更新，保留上次记录' :
    hasMore ? '正在分批补齐平台流水；统计仅覆盖已取得的记录' : '已同步当前账号与平台返回的积分流水';
  if (historyError) nextCursor = cursor;
  const keepWatermark = historyError || nextCursor;
  return {
    observedAt:timestamp(), status:'ok', message, collectionKey,
    partial:historyError || Boolean(nextCursor) || (poolAccess && !pool) || !subscription || (team && (!teamSnapshot || !teamSnapshot.membersComplete)),
    headEventId:keepWatermark ? (continuing ? previousEventId : null) : headEventId,
    nextCursor, pendingHeadEventId:keepWatermark ? headEventId : null,
    ...(subscription || {}),
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
      historyId:typeof r.historyId === 'string' ? r.historyId : '', submitId:typeof r.submitId === 'string' ? r.submitId : null, amount:amount(r.amount), title:name(r.title),
      historyType:r.historyType, createTime:r.createTime, status:name(r.status),
      teamId:r.teamId == null ? null : String(r.teamId),
      userId:r.userId == null ? (r.groupUserInfo?.uid == null ? null : String(r.groupUserInfo.uid)) : String(r.userId),
    })),
  };
}
