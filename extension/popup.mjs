import { diagnosticLabels,sanitizeDiagnostic } from './diagnostics.mjs';
const $=id=>document.getElementById(id);
const say=text=>{$('action-message').textContent=text;$('action-message').hidden=false;};
async function refreshStatus() {
  const response=await chrome.runtime.sendMessage({type:'popup-status'}).catch(()=>null);
  const status=response?.status || 'waiting';
  $('status').textContent=({ok:'正在自动采集',waiting:'等待打开即梦',
    error:'正在重试',login_required:'等待登录即梦'})[status] || '采集器已就绪';
  $('dot').className=status === 'ok' ? 'ok' : '';
  $('update').hidden=!response?.update;
  $('update-version').textContent=response?.update ? `新版 v${response.update.version} 可用` : '';
}
async function readLogs() {
  const data=(await chrome.storage.local.get('diagnostics')).diagnostics;
  return (Array.isArray(data?.entries)?data.entries:[]).map(sanitizeDiagnostic).filter(Boolean).slice(-200);
}
async function showLogs() {
  const logs=await readLogs();$('logs').replaceChildren();
  for (const log of logs.slice(-20).reverse()) {
    const item=document.createElement('li');
    const counts=typeof log.readTabs === 'number' ? ` · 已读 ${log.readTabs} 页${typeof log.skippedTabs === 'number' ? `，未读 ${log.skippedTabs} 页` : ''}` : '';
    item.textContent=`${new Date(log.at).toLocaleTimeString('zh-CN')} · ${diagnosticLabels[log.code]}${counts}${log.httpStatus ? `（${log.httpStatus}）` : ''}`;
    $('logs').append(item);
  }
  if (!logs.length) {const item=document.createElement('li');item.textContent='暂无诊断记录';$('logs').append(item);}
}
await refreshStatus();
chrome.storage.onChanged.addListener((changes,area)=>{
  if (area !== 'local') return;
  if (changes.state || changes.extensionUpdate) void refreshStatus();
  if (changes.diagnostics && $('troubleshooting').open) void showLogs();
});
$('troubleshooting').addEventListener('toggle',()=>{if ($('troubleshooting').open) void showLogs();});
$('download-update').addEventListener('click',async()=>{
  $('download-update').disabled=true;
  $('download-update').textContent='正在下载…';
  try {
    const result=await chrome.runtime.sendMessage({type:'download-update'});
    if (!result?.ok || typeof result.base64 !== 'string' || result.base64.length>14*1024*1024 || !/^jimeng-credit-manager-v\d+(?:\.\d+){0,3}\.zip$/.test(result.filename)) throw new Error('download failed');
    const binary=atob(result.base64),bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}));
    const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);say('更新包已下载，覆盖原文件夹后重新加载插件。');
  } catch {say('新版插件暂时无法下载，请稍后重试。');}
  finally {$('download-update').disabled=false;$('download-update').textContent='下载更新';}
});
$('copy-logs').addEventListener('click',async()=>{
  try {await navigator.clipboard.writeText(JSON.stringify({logs:await readLogs()},null,2));say('诊断日志已复制。');}
  catch {say('未能复制，请使用下载日志。');}
});
$('download-logs').addEventListener('click',async()=>{
  try {
    const url=URL.createObjectURL(new Blob([JSON.stringify({logs:await readLogs()},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`jimeng-diagnostics-${new Date().toISOString().slice(0,10)}.json`;
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);say('诊断日志已下载。');
  } catch {say('暂时无法导出日志，请稍后重试。');}
});
