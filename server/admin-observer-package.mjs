import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const allowedPermissions = new Set(['activeTab', 'scripting', 'storage']);
export const adminObserverFiles = [
  'manifest.json', 'popup.html', 'popup.css', 'popup.mjs', 'observer.mjs', 'page-reader.mjs', 'platform-prices.mjs', 'INSTALL.txt',
  'icons/yiqian-16.png', 'icons/yiqian-32.png', 'icons/yiqian-48.png', 'icons/yiqian-128.png',
];

export function adminObserverZip(directory, managementOrigin) {
  const url = new URL(managementOrigin);
  if (!['http:','https:'].includes(url.protocol) || url.origin !== managementOrigin ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('管理员观察版管理地址不合法');
  }
  const manifestPath = path.join(directory, 'manifest.json');
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) throw new Error('管理员观察版插件尚未就绪');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.permissions)) throw new Error('管理员观察版插件权限不符合只读要求');
  const permissions = new Set(manifest.permissions);
  if (manifest.manifest_version !== 3 ||
      !permissions.has('activeTab') || !permissions.has('scripting') ||
      [...permissions].some(permission => !allowedPermissions.has(permission)) ||
      manifest.host_permissions !== undefined || manifest.optional_host_permissions !== undefined ||
      manifest.optional_permissions !== undefined ||
      manifest.externally_connectable || manifest.content_scripts || manifest.background || manifest.web_accessible_resources) {
    throw new Error('管理员观察版插件权限不符合只读要求');
  }
  const files = {};
  for (const name of adminObserverFiles) {
    const full = path.join(directory, name);
    if (!existsSync(full)) throw new Error(`管理员观察版缺少文件：${name}`);
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error(`管理员观察版文件不符合要求：${name}`);
    files[name] = new Uint8Array(readFileSync(full));
  }
  files['management-origin.json'] = strToU8(JSON.stringify({origin:managementOrigin}));
  return zipSync(files, { level: 6 });
}
