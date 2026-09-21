import Button from '@douyinfe/semi-ui/lib/es/button';

export function CollectorReleasePanel({ release, installations, busy, onPublish }) {
  if (!release) return null;
  const outdated = installations.filter(device => device.enabled && device.updateAvailable).length;
  const unknown = installations.filter(device => device.enabled && device.versionUnknown).length;
  const announced = release.announcedVersion === release.version;
  return <section className="panel"><div className="panel-title"><div className="inline-title"><h2>插件更新</h2><span className="count-chip">最新版 v{release.version}</span></div><Button disabled={busy || announced} onClick={onPublish}>{announced ? '已发布更新提醒' : '推送更新提醒'}</Button></div><div className="table-footer"><span>{outdated} 个采集端待升级{unknown ? ` · ${unknown} 个版本待上报` : ''}</span></div></section>;
}
