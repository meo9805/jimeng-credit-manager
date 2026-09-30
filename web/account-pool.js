import { loginIdentitySummary } from './accounting.js';
import { linkedTeamsForLogin } from './teams.js';
import { creditExpiryRows, teamCreditExpiryEstimate } from './credit-expiry.js';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function accountPoolRows(identities,accounts,teams,usage,now=Date.now()) {
  const groups=new Map(loginIdentitySummary(accounts).groups.map(group=>[String(group.platformUserId),group]));
  return identities.map(identity=>{
    const uid=String(identity.platformUserId),group=groups.get(uid)??{platformUserId:uid,accounts:[],members:[],sharedWallets:[]};
    const links=linkedTeamsForLogin(group,teams).map(link=>{
      const roster=link.rosterMember??link.team?.members.find(member=>String(member.platformUserId)===uid);
      const rosterNewer=Date.parse(link.team?.observedAt||'')>=Date.parse(link.member?.lastSyncedAt||'')||!finite(link.member?.balance);
      const balance=rosterNewer&&finite(roster?.balance)?roster.balance:link.member?.balance??roster?.balance??null;
      const member=link.member&&rosterNewer&&finite(balance)?{...link.member,balance,subscriptionBalance:finite(link.member.subscriptionBalance)?Math.min(balance,link.member.subscriptionBalance):link.member.subscriptionBalance}:link.member;
      return {...link,balance,member};
    });
    const wallets=[group.personal,...links.map(link=>link.member)].filter(Boolean);
    const batches=wallets.flatMap(wallet=>{
      const rows=creditExpiryRows(wallet).map(batch=>({...batch,wallet,scope:wallet.scope}));
      const estimate=teamCreditExpiryEstimate(wallet);
      if(estimate&&wallet.subscriptionBalance>0)rows.push({key:'estimated',kind:'subscription',label:'会员',amount:wallet.subscriptionBalance,expiresAt:estimate.expiresAt,estimated:true,wallet,scope:wallet.scope});
      // A newer roster balance can reduce an older member-wallet snapshot.
      // Keep the expiry projection within the amount that remains available.
      let remaining=finite(wallet.balance)?wallet.balance:Infinity;
      return rows.sort((a,b)=>(a.expiresAt||'z').localeCompare(b.expiresAt||'z')).map(row=>{
        const amount=Math.min(row.amount,Math.max(0,remaining));remaining-=amount;
        return {...row,amount,estimated:row.estimated||amount<row.amount};
      }).filter(row=>row.amount>0);
    }).sort((a,b)=>(a.expiresAt||'z').localeCompare(b.expiresAt||'z'));
    const upcoming=batches.filter(batch=>batch.kind!=='gift'&&Date.parse(batch.expiresAt)>now&&Date.parse(batch.expiresAt)<=now+7*86400_000);
    const users=new Map();
    for(const item of usage.filter(item=>String(item.platformUserId)===uid)) {
      const key=item.employeeId||item.installationId,previous=users.get(key);
      if(!previous||item.lastSeenAt>previous.lastSeenAt)users.set(key,item);
    }
    return {...identity,group,links,batches,upcoming,users:[...users.values()],personalBalance:group.personal?.balance??null,
      teamBalance:links.some(link=>finite(link.balance))?links.reduce((sum,link)=>sum+(finite(link.balance)?link.balance:0),0):null};
  }).sort((a,b)=>Number(Boolean(b.realName))-Number(Boolean(a.realName))||(a.realName||a.nickname||a.platformUserId).localeCompare(b.realName||b.nickname||b.platformUserId,'zh-CN')||a.platformUserId.localeCompare(b.platformUserId));
}
