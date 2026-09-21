const EVENTS = {
  collector_started: ['采集器已启动', 'neutral'],
  collection_started: ['开始读取即梦数据', 'neutral'],
  collection_completed: ['数据采集完成', 'success'],
  collection_partial: ['数据采集部分完成', 'warning'],
  collection_failed: ['数据采集失败', 'error'],
  upload_failed: ['数据上报失败', 'error'],
  upload_recovered: ['数据上报已恢复', 'success'],
  connection_failed: ['管理服务连接失败', 'error'],
  connection_recovered: ['管理服务连接已恢复', 'success'],
  configuration_invalid: ['采集器配置无效', 'error'],
  command_failed: ['同步任务执行失败', 'error'],
  operation_saved: ['操作凭证已保存', 'neutral'],
  operation_uploaded: ['操作凭证已上报', 'success'],
  operation_upload_failed: ['操作凭证待补传', 'warning'],
  operation_save_failed: ['操作凭证暂未保存', 'error'],
  operation_queue_full: ['操作凭证队列已满', 'error'],
  operation_bridge_full: ['页面操作凭证积压，部分凭证未保存', 'error'],
};
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Display a fixed event vocabulary and numeric facts; never forward raw error payloads. */
export function diagnosticEntries(logs = []) {
  return logs.filter((log) => log && typeof log === 'object').map((log, index) => {
    const [label, severity] = typeof log.code === 'string' && Object.hasOwn(EVENTS, log.code) ? EVENTS[log.code] : ['其他采集事件', 'neutral'];
    const facts = [];
    if (Number.isInteger(log.httpStatus) && log.httpStatus >= 100 && log.httpStatus <= 599) facts.push(`HTTP ${log.httpStatus}`);
    for (const [key, title] of [['readTabs', '已读页面'], ['skippedTabs', '跳过页面'], ['pendingCount', '待上传记录']]) {
      const value = count(log[key]);
      if (value !== null) facts.push(`${key === 'pendingCount' && log.code === 'operation_uploaded' ? '本次上报凭证' : title} ${value}`);
    }
    if (typeof log.extensionVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(log.extensionVersion) && log.extensionVersion.length <= 40) facts.push(`插件 ${log.extensionVersion}`);
    return { key: typeof log.id === 'string' ? log.id : String(index), at: timestamp(log.at), label, severity, facts };
  }).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

export function diagnosticTimestamp(value) { return timestamp(value); }
