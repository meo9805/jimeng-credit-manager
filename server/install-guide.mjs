import { strToU8 } from 'fflate';

export const manualInstallGuide = `即梦积分管家：两种安装方式任选一种

先完整解压 ZIP，保留解压后的整个文件夹。不要在 ZIP 预览窗口里安装。
请使用分配给自己的安装包，在要使用的浏览器账号中登录管理员安排的即梦账号。之后切换即梦账号仍使用同一采集端，无需重装。

方式一：手动加载（不用运行安装助手）

1. 打开准备使用的 Chrome 或 Edge。若有多个浏览器账号，先切到日常使用的那个账号窗口。
2. 在地址栏输入：
   Chrome：chrome://extensions/
   Edge：edge://extensions/
3. 开启“开发者模式”。
4. 点击“加载未打包的扩展程序”或“加载解压缩的扩展”。
5. 选择包含 manifest.json 的整个解压文件夹，点击“选择文件夹”或“选择”。
   注意：选择的是文件夹，不是 manifest.json 文件。窗口内文件变灰是正常的。
   如果解压后多套了一层文件夹，要进入能看到 manifest.json 的那一层再确认。

也可以把整个解压文件夹拖进上面的扩展管理页面；拖动的不是 ZIP 或单个文件。
看到“即梦积分管家”且已启用后，刷新即梦网页，即可自动采集。
不要删除或移动已加载的文件夹。

方式二：安装助手（可选）

Windows：双击 Windows-双击安装.cmd。
Mac：双击 Mac-双击安装.command。
助手帮助打开浏览器扩展页和插件目录，最后仍需按页面提示加载文件夹。
如果 Windows 弹出浏览器账号选择，先选好账号，再回助手按提示继续。
若没有跳到扩展页、脚本报错或被系统阻止，直接使用方式一即可。
Windows 助手报错时保留窗口，并显示日志保存位置，便于排查。

以后更新：解压新版覆盖原来的插件文件夹，然后在扩展管理页点“重新加载”，再刷新即梦。
`;

export function installGuideEntries() {
  // BOM keeps the Chinese instructions readable in older Windows Notepad.
  return { '安装说明.txt':strToU8('\uFEFF' + manualInstallGuide.replaceAll('\n','\r\n')) };
}
