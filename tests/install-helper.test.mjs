import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {zipSync,unzipSync,strFromU8,strToU8} from 'fflate';
import {installHelperEntries,windowsInstallHelper,macInstallHelper} from '../server/install-helper.mjs';

test('both static helpers preserve manual loading and provide a choice before opening browser or clipboard',()=>{
  const files=unzipSync(zipSync({'manifest.json':strToU8('{"manifest_version":3}'),...installHelperEntries()}));
  assert.deepEqual(Object.keys(files).sort(),['Mac-双击安装.command','Windows-双击安装.cmd','manifest.json']);
  const windows=strFromU8(files['Windows-双击安装.cmd']),mac=strFromU8(files['Mac-双击安装.command']);
  assert.equal(windows,windowsInstallHelper);assert.equal(mac,macInstallHelper);
  assert.match(windows,/setlocal DisableDelayedExpansion/);assert.match(windows,/set "JMC_INSTALL_DIR=%~dp0"/);
  assert.ok(Math.max(...windows.split(/\r?\n/).map(line=>line.length))<8191,'cmd lines fit the Windows command-line limit');
  const encoded=windows.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const powershell=Buffer.from(encoded,'base64').toString('utf16le');
  assert.match(powershell,/\$root = \$env:JMC_INSTALL_DIR/);
  assert.match(powershell,/Test-Path -LiteralPath/);assert.match(powershell,/GetEnvironmentVariable\('ProgramFiles\(x86\)'\)/);
  assert.match(powershell,/IsNullOrWhiteSpace\(\$answer\)\) \{ exit 0 \}/);
  assert.ok(powershell.indexOf('IsNullOrWhiteSpace')<powershell.indexOf('CopyValue $root'));
  assert.ok(mac.indexOf('if [[ -z "$selection" ]]; then exit 0; fi')<mac.indexOf('/usr/bin/pbcopy'));
  assert.match(mac,/\/usr\/bin\/osascript - "\$chrome_path" "\$edge_path"/);
  assert.match(mac,/\/usr\/bin\/osascript - "\$script_dir" "\$extension_page"/);
  for(const script of [powershell,mac]){
    for(const text of ['Chrome','Edge','chrome://extensions/','edge://extensions/','开发者模式','当前解压文件夹','管理员安排的即梦账号'])assert.ok(script.includes(text),text);
    assert.doesNotMatch(script,/ExecutionPolicy|Invoke-WebRequest|https?:\/\/|jimeng\.jianying\.com|provision\.json|Authorization|token|sudo|xattr|reg(?:edit|\.exe)|User Data|--load-extension/);
  }
});

test('Windows helper resumes after the browser account picker and keeps recoverable fallback actions',()=>{
  const encoded=windowsInstallHelper.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const ps=Buffer.from(encoded,'base64').toString('utf16le');
  const launch=ps.indexOf("OpenPage ''"),continuePrompt=ps.indexOf("Read-Host '若浏览器弹出账号选择"),openExtensions=ps.indexOf('OpenPage $selected.Url');
  assert.ok(launch>0&&continuePrompt>launch&&openExtensions>continuePrompt);
  assert.match(ps,/账号.*回车继续，q取消/);
  assert.match(ps,/'r' \{ OpenPage \$selected.Url \}/);
  assert.match(ps,/'u' \{ CopyValue \$selected.Url \}/);
  assert.match(ps,/'p' \{ CopyValue \$root \}/);
  assert.match(ps,/文件灰色正常/);assert.match(ps,/整个文件夹拖到扩展页/);
  assert.match(ps,/Add-Content -LiteralPath \$log/);
  assert.match(ps,/\.Exception.GetType\(\).Name/);
  assert.doesNotMatch(ps,/\.Exception\.Message|\.Exception\.ToString|Stop-Process|--profile-directory/);
  assert.match(windowsInstallHelper,/if errorlevel 1 \([\s\S]*?pause/);
  assert.match(ps,/助手未完成，请按安装说明\.txt手动加载/);
});

test('Mac ZIP entry is Unix executable and extraction retains the original root layout',t=>{
  const zip=Buffer.from(zipSync({'manifest.json':strToU8('{}'),...installHelperEntries()}));
  const entries=new Map();let at=0;
  while((at=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),at))!==-1){
    const nameLength=zip.readUInt16LE(at+28),extraLength=zip.readUInt16LE(at+30),commentLength=zip.readUInt16LE(at+32);
    entries.set(zip.subarray(at+46,at+46+nameLength).toString(),{os:zip[at+5],mode:zip.readUInt32LE(at+38)>>>16,utf8:Boolean(zip.readUInt16LE(at+8)&0x800)});
    at+=46+nameLength+extraLength+commentLength;
  }
  assert.deepEqual(entries.get('Mac-双击安装.command'),{os:3,mode:0o100755,utf8:true});
  assert.deepEqual(entries.get('Windows-双击安装.cmd'),{os:3,mode:0o100644,utf8:true});
  if(process.platform!=='darwin')return;
  const dir=mkdtempSync(path.join(os.tmpdir(),"jmc-安装 ' & 空格-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const zipPath=path.join(dir,'测试安装包.zip'),unpacked=path.join(dir,'解压文件夹');writeFileSync(zipPath,zip);
  execFileSync('/usr/bin/ditto',['-x','-k',zipPath,unpacked]);
  const helper=path.join(unpacked,'Mac-双击安装.command');
  assert.equal(statSync(helper).mode&0o777,0o755);
  assert.equal(readFileSync(helper,'utf8'),macInstallHelper);
  assert.equal(readFileSync(path.join(unpacked,'manifest.json'),'utf8'),'{}');
  execFileSync('/bin/bash',['-n',helper]);
  for(const [index,script] of [...macInstallHelper.matchAll(/<<'APPLESCRIPT'\n([\s\S]*?)\nAPPLESCRIPT/g)].entries()){
    const source=path.join(dir,`dialog-${index}.applescript`);writeFileSync(source,script[1]);
    execFileSync('/usr/bin/osacompile',['-o',path.join(dir,`dialog-${index}.scpt`),source]);
  }
});
