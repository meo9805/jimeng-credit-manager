export const diagnosticLabels = Object.freeze({
  collector_started:'采集器已启动',collection_started:'开始核对积分',collection_completed:'本轮采集完成',
  collection_partial:'本轮有页面未完成采集',collection_failed:'本轮采集未完成',upload_failed:'数据暂未上传成功',
  upload_recovered:'数据上传已恢复',connection_failed:'采集服务暂时无法连接',connection_recovered:'采集服务连接已恢复',
  configuration_invalid:'插件配置未就绪',command_failed:'管理者发起的同步暂未完成',
  operation_saved:'操作凭证已保存',operation_uploaded:'操作凭证已上报',operation_upload_failed:'操作凭证待补传',
  operation_save_failed:'操作凭证暂未保存',operation_queue_full:'操作凭证队列已满',
  operation_bridge_full:'页面操作凭证积压，部分凭证未保存',
});
export function sanitizeDiagnostic(input) {
  if (!input || !Object.hasOwn(diagnosticLabels,input.code) || typeof input.id !== 'string' ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(input.id) || typeof input.at !== 'string' ||
    !Number.isFinite(Date.parse(input.at)) || new Date(input.at).toISOString() !== input.at) return null;
  const entry = {id:input.id,at:input.at,code:input.code};
  if (typeof input.extensionVersion === 'string' && /^\d+(?:\.\d+){1,3}$/.test(input.extensionVersion)) entry.extensionVersion=input.extensionVersion;
  for (const [key,min,max] of [['httpStatus',100,599],['readTabs',0,100],['skippedTabs',0,100],['pendingCount',0,10000]]) {
    if (Number.isInteger(input[key]) && input[key]>=min && input[key]<=max) entry[key]=input[key];
  }
  return entry;
}
export function createDiagnosticLog(storage,extensionVersion) {
  let work=Promise.resolve(),upload=null;
  const serialize=fn=>{const next=work.then(fn,fn);work=next.catch(()=>{});return next;};
  const read=async()=>{
    const raw=(await storage.get('diagnostics')).diagnostics || {};
    const entries=(Array.isArray(raw.entries)?raw.entries:[]).map(sanitizeDiagnostic).filter(Boolean).slice(-200);
    const known=new Set(entries.map(e=>e.id));
    return {entries,pending:[...new Set(Array.isArray(raw.pending)?raw.pending:[])].filter(id=>known.has(id))};
  };
  return {
    record(code,fields={}) {
      return serialize(async()=>{
        const entry=sanitizeDiagnostic({...fields,id:crypto.randomUUID(),at:new Date().toISOString(),code,extensionVersion});
        if (!entry) return;
        const data=await read();data.entries=[...data.entries,entry].slice(-200);
        const retained=new Set(data.entries.map(e=>e.id));
        data.pending=[...data.pending,entry.id].filter(id=>retained.has(id));
        await storage.set({diagnostics:data});
      }).catch(()=>{});
    },
    snapshot() {return serialize(async()=>(await read()).entries).catch(()=>[]);},
    flush(send) {
      if (upload) return upload;
      upload=(async()=>{
        const batch=await serialize(async()=>{const data=await read(),pending=new Set(data.pending);return data.entries.filter(e=>pending.has(e.id)).slice(0,50);});
        if (!batch.length) return;
        const response=await send(batch);
        if (response?.accepted !== true) return;
        await serialize(async()=>{
          const data=await read(),accepted=new Set(batch.map(e=>e.id));
          data.pending=data.pending.filter(id=>!accepted.has(id));await storage.set({diagnostics:data});
        });
      })().catch(()=>{}).finally(()=>{upload=null;});
      return upload;
    },
  };
}
