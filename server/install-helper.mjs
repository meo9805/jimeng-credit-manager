import {strToU8} from 'fflate';

const windowsPowerShell = String.raw`$ErrorActionPreference = 'Stop'
$root = $env:JMC_INSTALL_DIR
$log = Join-Path ([IO.Path]::GetTempPath()) ('jmc-install-'+[guid]::NewGuid().ToString('N')+'.log')
function Log($step) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format s)+' '+$step) -Encoding UTF8 } catch {} }
function OpenPage($url) { try { if ($url) { Start-Process -FilePath $selected.Path -ArgumentList $url } else { Start-Process -FilePath $selected.Path }; Log 'browser_open' } catch { Log $_.Exception.GetType().Name; Write-Host ('请自行打开 '+$selected.Url) } }
function CopyValue($value) { try { Set-Clipboard -Value $value; Write-Host '已复制。' } catch { Log $_.Exception.GetType().Name; Write-Host '请手动复制上方地址。' } }
try {
Log 'started'
Write-Host ('排障日志：'+$log)
if (!(Test-Path -LiteralPath (Join-Path $root 'manifest.json') -PathType Leaf)) { throw '请先完整解压安装包。' }
$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$choices = @()
foreach ($b in @(@('Chrome','Google\Chrome\Application\chrome.exe','chrome://extensions/'),@('Edge','Microsoft\Edge\Application\msedge.exe','edge://extensions/'))) {
  $exe = @($env:ProgramFiles,$programFilesX86,$env:LOCALAPPDATA) | Where-Object { $_ } | ForEach-Object { Join-Path $_ $b[1] } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($exe) { $choices += [pscustomobject]@{Name=$b[0];Path=$exe;Url=$b[2]} }
}
if (!$choices.Count) { throw '未找到 Chrome 或 Edge，请手动安装。' }
Write-Host '即梦采集端安装助手'
Write-Host '请先登录管理员安排的即梦账号。'
for ($i = 0; $i -lt $choices.Count; $i++) { Write-Host (('{0}. {1}' -f ($i + 1), $choices[$i].Name)) }
$answer = Read-Host '输入浏览器序号，直接回车取消'
if ([string]::IsNullOrWhiteSpace($answer)) { exit 0 }
$index = 0
if (![int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $choices.Count) { throw '无效的浏览器序号。' }
$selected = $choices[$index - 1]
OpenPage ''
if ((Read-Host '若浏览器弹出账号选择，请先选好账号；回到这里按回车继续，q取消') -eq 'q') { exit 0 }
Log 'profile_selection_done'
OpenPage $selected.Url
CopyValue $root
try { (New-Object -ComObject Shell.Application).Open($root) } catch { Log $_.Exception.GetType().Name }
Write-Host ('扩展页：'+$selected.Url)
Write-Host ('插件目录：'+$root)
Write-Host '开启开发者模式，点击加载未打包的扩展程序，选择包含 manifest.json 的当前解压文件夹。'
Write-Host '选整个目录；文件灰色正常。也可把整个文件夹拖到扩展页。不要删除该目录。'
Write-Host '若仍停在账号选择页，用 u 复制扩展页地址，粘贴到选好的浏览器窗口地址栏。'
Write-Host '看到即梦积分管家已启用才算装好，再刷新即梦。也可按安装说明.txt手动加载。'
do {
  $action = Read-Host 'r重试打开，u复制扩展页地址，p复制插件目录，回车退出'
  switch ($action) { 'r' { OpenPage $selected.Url } 'u' { CopyValue $selected.Url } 'p' { CopyValue $root } }
} while (![string]::IsNullOrWhiteSpace($action))
Log 'finished'
} catch {
Log $_.Exception.GetType().Name
Write-Host '助手未完成，请按安装说明.txt手动加载。'
Write-Host ('排障日志：'+$log)
exit 1
}`;

// EncodedCommand only transports static UTF-16 script text safely through cmd's
// parser; it neither downloads code nor changes PowerShell execution policy.
export const windowsInstallHelper = `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "JMC_INSTALL_DIR=%~dp0"\r\npowershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(windowsPowerShell,'utf16le').toString('base64')}\r\nif errorlevel 1 (\r\n  echo Installer failed. Please use the manual guide in this folder.\r\n  pause\r\n)\r\nendlocal\r\n`;

export const macInstallHelper = String.raw`#!/bin/bash
set -eu
script_dir="$(cd -P -- "$(dirname "$0")" && pwd)"
if [[ ! -f "$script_dir/manifest.json" ]]; then
  /usr/bin/osascript -e 'display alert "请先完整解压安装包，再双击此文件。"'
  exit 1
fi
chrome_path=''
edge_path=''
for app in '/Applications/Google Chrome.app' "$HOME/Applications/Google Chrome.app"; do
  if [[ -d "$app" ]]; then chrome_path="$app"; break; fi
done
for app in '/Applications/Microsoft Edge.app' "$HOME/Applications/Microsoft Edge.app"; do
  if [[ -d "$app" ]]; then edge_path="$app"; break; fi
done
if [[ -z "$chrome_path" && -z "$edge_path" ]]; then
  /usr/bin/osascript -e 'display alert "未找到 Chrome 或 Edge，请先安装其中一个浏览器。"'
  exit 1
fi
selection=$(/usr/bin/osascript - "$chrome_path" "$edge_path" <<'APPLESCRIPT'
on run argv
  set browserNames to {}
  if item 1 of argv is not "" then set end of browserNames to "Chrome"
  if item 2 of argv is not "" then set end of browserNames to "Edge"
  set choice to choose from list browserNames with title "即梦采集端安装助手" with prompt "请先在准备安装的浏览器中登录管理员安排的即梦账号，再选择浏览器。" OK button name "打开安装页" cancel button name "取消"
  if choice is false then return ""
  return item 1 of choice
end run
APPLESCRIPT
)
if [[ -z "$selection" ]]; then exit 0; fi
case "$selection" in
  Chrome) browser_path="$chrome_path"; extension_page='chrome://extensions/' ;;
  Edge) browser_path="$edge_path"; extension_page='edge://extensions/' ;;
  *) exit 0 ;;
esac
printf '%s' "$script_dir" | /usr/bin/pbcopy
/usr/bin/open -a "$browser_path" "$extension_page" || true
/usr/bin/open "$script_dir"
/usr/bin/osascript - "$script_dir" "$extension_page" <<'APPLESCRIPT'
on run argv
  display dialog "插件文件夹路径已复制。" & return & return & "1. 在浏览器扩展页开启开发者模式。" & return & "2. 点击加载已解压的扩展程序（或加载解压缩的扩展）。" & return & "3. 选择当前解压文件夹；选择窗口可按 ⌘⇧G，再粘贴路径。" & return & return & "请保留这个文件夹。浏览器显示即梦积分管家后，安装才完成；再刷新即梦页面。" & return & return & "若未打开扩展页，请在浏览器地址栏输入：" & item 2 of argv & return & "插件文件夹：" & item 1 of argv buttons {"知道了"} default button "知道了" with title "请在浏览器中完成安装"
end run
APPLESCRIPT
`;

export function installHelperEntries() {
  return {
    'Windows-双击安装.cmd': [strToU8(windowsInstallHelper),{os:3,attrs:0o100644<<16}],
    'Mac-双击安装.command': [strToU8(macInstallHelper),{os:3,attrs:0o100755<<16}],
  };
}
