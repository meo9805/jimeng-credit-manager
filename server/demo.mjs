// Deterministic, fictional fixtures. They are never written into the live database.
export function demoDashboard() {
  const asOf = '2026-09-12T09:30:00.000Z';
  const base = { giftBalance: null, purchaseBalance: null, subscriptionBalance: null, expiresAt: '2026-09-20T00:00:00.000Z', membershipPlan:null, billingCycle:null, membershipExpiresAt:null, nextRenewalAt:null, subscriptionObservedAt:null, lastSyncedAt: asOf, source: 'demo', status: 'ok' };
  const accounts = [
    { ...base, id:'demo-personal-a', platformUserId:'demo-1001', spaceId:'0', spaceType:'personal', scope:'personal', displayName:'林晓 · 常用账号', spaceName:'个人空间', ownerName:'林晓', ownerDepartment:'AI 短剧', balance:1280, giftBalance:0, purchaseBalance:280, subscriptionBalance:1000 },
    { ...base, id:'demo-personal-b', platformUserId:'demo-1002', spaceId:'0', spaceType:'personal', scope:'personal', displayName:'林晓 · 备用账号', spaceName:'个人空间', ownerName:'林晓', ownerDepartment:'AI 短剧', balance:420, giftBalance:0, purchaseBalance:420, subscriptionBalance:0, expiresAt:'2027-02-01T00:00:00.000Z' },
    { ...base, id:'demo-team', platformUserId:'demo-1001', spaceId:'demo-team-01', spaceType:'team', scope:'team_total', displayName:'公司创作团队', spaceName:'短剧创作空间', ownerName:'林晓', ownerDepartment:'AI 短剧', balance:9200, giftBalance:0, purchaseBalance:0, subscriptionBalance:9200 },
    { ...base, id:'demo-member', platformUserId:'demo-2001', spaceId:'demo-team-01', spaceType:'team', scope:'team_member', displayName:'张宁 · 团队成员额度', spaceName:'短剧创作空间', ownerName:'张宁', ownerDepartment:'教研', balance:1600, giftBalance:0, purchaseBalance:0, subscriptionBalance:1600 },
    { ...base, id:'demo-research', platformUserId:'demo-2001', spaceId:'0', spaceType:'personal', scope:'personal', displayName:'张宁 · 教学素材', spaceName:'个人空间', ownerName:'张宁', ownerDepartment:'教研', balance:760, giftBalance:0, purchaseBalance:0, subscriptionBalance:760 },
    { ...base, id:'demo-agri', platformUserId:'demo-3001', spaceId:'0', spaceType:'personal', scope:'personal', displayName:'周禾 · 农技视频', spaceName:'个人空间', ownerName:'周禾', ownerDepartment:'农资', balance:null, giftBalance:null, purchaseBalance:null, subscriptionBalance:null, expiresAt:null, lastSyncedAt:'2026-09-10T03:00:00.000Z', status:'unknown' },
  ];
  const event = (id, accountId, occurredAt, kind, amount, description, operatorName = null, operatorDepartment = null) => ({ id, eventId:id, accountId, chargedPlatformUserId:accountId === 'demo-team' ? 'demo-2001' : accounts.find(account=>account.id === accountId)?.platformUserId ?? null, occurredAt, kind, amount, description, operatorName, operatorDepartment, attribution:operatorName ? 'matched' : 'unconfirmed', source:'demo' });
  const transactions = [
    event('demo-tx-1','demo-team','2026-09-12T09:20:00.000Z','consume',-120,'视频生成 · 演示跨部门使用','张宁','教研'),
    event('demo-tx-2','demo-personal-a','2026-09-12T08:40:00.000Z','refund',60,'生成失败返还 · 演示'),
    event('demo-tx-3','demo-personal-a','2026-09-12T08:35:00.000Z','consume',-60,'视频生成 · 演示'),
    event('demo-tx-4','demo-research','2026-09-12T07:30:00.000Z','consume',-40,'教学配图 · 演示'),
    event('demo-tx-5','demo-personal-b','2026-09-11T09:00:00.000Z','grant',500,'充值到账 · 演示'),
    event('demo-tx-6','demo-research','2026-09-11T00:00:00.000Z','expire',-200,'订阅积分到期 · 演示'),
  ];
  const installation = (id, employeeName, department, status, accountCount, lastSeenAt) => ({id,employeeName,department,role:'collector',enabled:true,createdAt:'2026-09-10T01:00:00.000Z',lastSeenAt,lastCommandPollAt:null,online:false,status,message:status === 'login_required' ? '即梦登录已失效（演示）' : null,accountCount});
  const teams = [{spaceId:'demo-team-01',name:'短剧创作空间',creatorPlatformUserId:'demo-1001',creatorDisplayName:'林晓',membershipPlan:'团队高级会员（演示）',membershipExpiresAt:'2026-10-12T00:00:00.000Z',totalBalance:9200,allocatableBalance:0,totalSeats:4,availableSeats:0,membersComplete:true,observedAt:asOf,balanceObservedAt:asOf,source:'demo',members:[
    {platformUserId:'demo-1001',displayName:'林晓',role:'creator',usedCredits:380,balance:4200,joinedAt:'2026-09-01T00:00:00.000Z'},
    {platformUserId:'demo-4001',displayName:'陈舟',role:'admin',usedCredits:null,balance:null,joinedAt:null},
    {platformUserId:'demo-2001',displayName:'张宁',role:'member',usedCredits:120,balance:1600,joinedAt:'2026-09-05T00:00:00.000Z'},
    {platformUserId:'demo-3001',displayName:'周禾',role:'member',usedCredits:0,balance:1400,joinedAt:'2026-09-08T00:00:00.000Z'},
  ]}];
  const identities = [
    {platformUserId:'demo-1001',nickname:'林间光影',realName:'林晓',department:'AI 短剧',updatedAt:asOf},
    {platformUserId:'demo-1002',nickname:'胶片匣',realName:'林晓',department:'AI 短剧',updatedAt:asOf},
    {platformUserId:'demo-2001',nickname:'纸飞机',realName:'张宁',department:'教研',updatedAt:asOf},
    {platformUserId:'demo-3001',nickname:'麦田',realName:'周禾',department:'农资',updatedAt:asOf},
    {platformUserId:'demo-4001',nickname:'舟行',realName:null,department:null,updatedAt:null},
  ];
  for (const person of identities) {
    for (const account of accounts) if (account.scope !== 'team_total' && account.platformUserId === person.platformUserId) account.displayName = person.nickname;
    for (const team of teams) {
      if (team.creatorPlatformUserId === person.platformUserId) team.creatorDisplayName = person.nickname;
      for (const member of team.members) if (member.platformUserId === person.platformUserId) member.displayName = person.nickname;
    }
  }
  return {mode:'demo',asOf,accounts,teams,transactions,identities,installations:[installation('demo-device-1','林晓','AI 短剧','ok',3,asOf),installation('demo-device-2','张宁','教研','ok',2,asOf),installation('demo-device-3','周禾','农资','login_required',1,'2026-09-10T03:00:00.000Z')]};
}
