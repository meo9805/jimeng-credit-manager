import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validatePlatformPrices} from '../server/platform-prices.mjs';

const MANAGEMENT_ORIGIN = process.env.JMC_MANAGEMENT_ORIGIN || 'http://127.0.0.1:4318';

export async function uploadPlatformPrices({origin=MANAGEMENT_ORIGIN,secret,payload,request=fetch}) {
  if (typeof secret !== 'string' || !secret) throw new Error('管理台凭据不可用');
  const validated = validatePlatformPrices(payload,Date.now());
  let cookie;
  try {
    const login = await request(`${origin}/api/admin/login`,{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({secret}),signal:AbortSignal.timeout(15_000),
    });
    if (!login.ok) throw new Error(`管理台登录失败 (${login.status})`);
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie?.startsWith('jmc_admin=')) throw new Error('管理台没有返回登录会话');
    const response = await request(`${origin}/api/admin/platform-prices`,{
      method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},
      body:JSON.stringify(validated),signal:AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`管理台标价同步失败 (${response.status})`);
    const result = await response.json();
    if (result.products !== validated.products.length || !Number.isSafeInteger(result.version))
      throw new Error('管理台标价同步回执无效');
    const check = await request(`${origin}/api/admin/platform-prices`,{
      method:'GET',headers:{Cookie:cookie},signal:AbortSignal.timeout(10_000),
    });
    if (!check.ok) throw new Error(`管理台标价回读失败 (${check.status})`);
    const saved = (await check.json()).catalog;
    if (saved?.version !== result.version || saved.products?.length !== validated.products.length ||
        saved.lastObservedAt !== result.lastObservedAt) throw new Error('管理台标价回读与同步回执不一致');
    return {version:result.version,changed:Boolean(result.changed),products:result.products,
      revisedWallets:result.revisedWallets,observedAt:result.observedAt};
  } finally {
    if (cookie) await request(`${origin}/api/admin/logout`,{
      method:'POST',headers:{Origin:origin,Cookie:cookie},signal:AbortSignal.timeout(10_000),
    }).catch(()=>{});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file=process.argv[2];
    if (!file) throw new Error('缺少标价文件');
    const payload=JSON.parse(await readFile(file,'utf8'));
    const result=await uploadPlatformPrices({secret:process.env.JMC_ADMIN_SECRET,payload});
    console.log(JSON.stringify(result));
  } catch(error) {
    console.error(error instanceof Error ? error.message : '平台标价同步失败');
    process.exitCode=1;
  }
}
