#!/bin/zsh
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if [[ -z "${JMC_ADMIN_SECRET:-}" ]]; then
  print -u2 '请通过受控凭据注入设置 JMC_ADMIN_SECRET'
  exit 1
fi

project_dir=${0:A:h:h}
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/jimeng-platform-prices.XXXXXX")
chmod 700 "$temporary_dir"
trap 'rm -f "$temporary_dir/catalog.json"; rmdir "$temporary_dir"' EXIT

space_id=${JMC_EGO_SPACE_ID:-}
if [[ -n "$space_id" && ! "$space_id" =~ '^[0-9]+$' ]]; then
  print -u2 '无效的 ego lite taskSpace ID'
  exit 1
fi

ego-browser nodejs <<EGO
const fs = await import('node:fs/promises');
const {readPlatformPrices,priceDraft} = await import('${project_dir}/admin-extension/platform-prices.mjs');
const existingId = '${space_id}';
const task = existingId ? await taskSpace(Number(existingId)) : await taskSpace('即梦每日平台标价');
let failure = null;
try {
  const page = task.page('p1');
  await page.goto('https://jimeng.jianying.com/ai-tool/home/');
  await page.waitForFunction(
    () => Boolean(window.__debugger?.DreaminaCommercialFeatureService?._containerService?.invokeFunction),
    undefined,
    {timeout: 30_000},
  );
  let reading;
  for (let attempt = 0; attempt < 6; attempt++) {
    reading = await page.evaluate(readPlatformPrices);
    if (reading?.ok || !['page_not_ready','price_api_unavailable'].includes(reading?.reason)) break;
    if (attempt < 5) await page.waitForTimeout(2500);
  }
  if (!reading?.ok) throw new Error('即梦平台标价读取失败：' + (reading?.reason ?? 'unknown'));
  const draft = priceDraft(reading);
  if (!draft) throw new Error('即梦平台标价校验失败');
  await fs.writeFile('${temporary_dir}/catalog.json',JSON.stringify(draft),{flag:'wx',mode:0o600});
  console.log('即梦标价已读取：' + draft.products.length + ' 个商品');
} catch (error) {
  failure = error;
}
try {
  // This scheduled task owns its tabs; never leave a price-reading tab open.
  await task.finish({keep:[]});
} catch (error) {
  console.error('ego lite 标签关闭失败：' + (error?.message ?? 'unknown'));
  if (!failure) failure = error;
}
if (failure) throw failure;
EGO

node "$project_dir/scripts/upload-platform-prices.mjs" "$temporary_dir/catalog.json"
