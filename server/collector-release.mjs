import { readFileSync } from 'node:fs';
import path from 'node:path';

export const validExtensionVersion = value => typeof value==='string'&&/^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value);
export function readCollectorRelease(extensionDir) {
  const {version}=JSON.parse(readFileSync(path.join(extensionDir,'manifest.json'),'utf8'));
  if(!validExtensionVersion(version))throw new Error('采集器发布版本无效');
  return {version,distribution:'unpacked'};
}
export function collectorVersionStatus(device,release) {
  const versionUnknown=!validExtensionVersion(device.extensionVersion);
  let comparison=0;
  if(!versionUnknown){
    const observed=device.extensionVersion.split('.').map(Number),latest=release.version.split('.').map(Number);
    for(let index=0;index<4;index++){
      comparison=(observed[index]??0)-(latest[index]??0);
      if(comparison)break;
    }
  }
  return {versionUnknown,updateAvailable:!versionUnknown&&comparison<0};
}
