const requestForm = document.querySelector('#request-form');
const result = document.querySelector('#request-result');
const loading = document.querySelector('#loading-state');
const requestError = document.querySelector('#request-error');
const submitButton = document.querySelector('#submit-request');
const resultActions = document.querySelector('#result-actions');
const statusMark = document.querySelector('#status-mark');
const statusTitle = document.querySelector('#status-title');
const statusDescription = document.querySelector('#status-description');
const requestPerson = document.querySelector('#request-person');
const connectionStatus = document.querySelector('#connection-status');

let currentRequest = null;
let pollTimer = null;
let isChecking = false;
let endedClaimId = null;
let browser = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
let os = /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'mac' : 'windows';

function errorMessage(payload, fallback) {
  return typeof payload?.error === 'string' ? payload.error :
    typeof payload?.message === 'string' ? payload.message : fallback;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function showError(message) {
  requestError.textContent = message;
  requestError.hidden = !message;
}

function clearPoll() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  clearPoll();
  if (currentRequest?.status !== 'pending' && !(currentRequest?.status === 'claimed' && currentRequest.collector && !currentRequest.collector.online)) return;
  pollTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') refreshRequest();
    else schedulePoll();
  }, 15000);
}

function action(label, onClick, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'primary-button' : 'text-button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  resultActions.append(button);
  return button;
}

function showForm(previousRequest = null) {
  clearPoll();
  currentRequest = null;
  loading.hidden = true;
  result.hidden = true;
  connectionStatus.hidden = true;
  requestForm.hidden = false;
  if (previousRequest) {
    document.querySelector('#employee-name').value = previousRequest.name || '';
    document.querySelector('#employee-department').value = previousRequest.department || '';
  }
}

function showRequest(request) {
  if (currentRequest?.id !== request.id) endedClaimId = null;
  currentRequest = request;
  loading.hidden = true;
  requestForm.hidden = true;
  result.hidden = false;
  resultActions.replaceChildren();
  statusMark.className = `status-mark ${request.status}`;
  const person = request.employeeName && ['approved', 'claimed'].includes(request.status)
    ? `已绑定：${request.employeeName}`
    : [request.name, request.department].filter(Boolean).join(' · ');
  requestPerson.textContent = person;
  requestPerson.hidden = !person;
  connectionStatus.hidden = true;
  connectionStatus.className = 'connection-status';
  showError('');

  if (request.status === 'pending') {
    statusMark.textContent = '…';
    statusTitle.textContent = '管理员正在核对';
    statusDescription.textContent = '通过后，这里会自动显示你的下载按钮。请用当前浏览器和这条链接回来领取。';
    schedulePoll();
  } else if (request.status === 'approved') {
    clearPoll();
    statusMark.textContent = '✓';
    statusTitle.textContent = '可以下载了';
    statusDescription.textContent = '这份安装包只属于你，请勿转发给其他人。';
    action('下载我的采集端', downloadPackage, true);
  } else if (request.status === 'claimed') {
    clearPoll();
    statusMark.textContent = '✓';
    statusTitle.textContent = '安装包已领取';
    const canRetry = request.id !== endedClaimId && request.claimedAt && Date.parse(request.claimedAt) + 15 * 60 * 1000 > Date.now();
    statusDescription.textContent = canRetry ? '如果下载中断，可在领取后 15 分钟内重试。' : '请按下方步骤安装。如需再次领取，请重新提交申请。';
    if (canRetry) action('重新下载', downloadPackage, true);
    else action('重新申请', () => showForm(request));
    if (request.collector) {
      const version = request.collector.extensionVersion ? ` · v${String(request.collector.extensionVersion).replace(/^v/, '')}` : '';
      connectionStatus.textContent = request.collector.online ? `已连接${version}` :
        request.collector.lastSeenAt ? `已连接过${version}，打开即梦后会继续采集` :
          '打开即梦并刷新，稍后这里会显示连接状态';
      connectionStatus.classList.toggle('online', Boolean(request.collector.online));
      connectionStatus.hidden = false;
      schedulePoll();
    }
  } else if (request.status === 'rejected') {
    clearPoll();
    statusMark.textContent = '!';
    statusTitle.textContent = '申请未通过';
    statusDescription.textContent = '请与管理员核对姓名和部门后重新提交。';
    action('重新填写', () => showForm(request));
  } else if (request.status === 'expired') {
    clearPoll();
    statusMark.textContent = '!';
    statusTitle.textContent = '申请已失效';
    statusDescription.textContent = '请重新提交领取申请。';
    action('重新申请', () => showForm(request));
  } else {
    clearPoll();
    showForm();
  }
}

async function refreshRequest(initial = false) {
  if (isChecking) return;
  isChecking = true;
  try {
    const response = await fetch('/api/enrollment/request', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }
    });
    if (response.status === 401) {
      const hadRequest = Boolean(currentRequest);
      showForm();
      if (hadRequest) showError('当前浏览器的领取记录已失效，请重新提交。');
      return;
    }
    const payload = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '暂时无法读取申请状态，请稍后重试。'));
    showRequest(payload);
  } catch (error) {
    if (initial) {
      loading.hidden = true;
      result.hidden = false;
      requestForm.hidden = true;
      requestPerson.hidden = true;
      statusMark.className = 'status-mark rejected';
      statusMark.textContent = '!';
      statusTitle.textContent = '暂时无法读取申请';
      statusDescription.textContent = '请检查网络后重试。';
      resultActions.replaceChildren();
      action('重试', () => refreshRequest(true), true);
    } else {
      showError(error.message || '网络暂时不可用，稍后会自动重试。');
      schedulePoll();
    }
  } finally {
    isChecking = false;
  }
}

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#employee-name').value.trim();
  const department = document.querySelector('#employee-department').value.trim();
  if (!name || !department) {
    showError('请填写姓名和部门。');
    return;
  }
  if (name.length > 40 || department.length > 60) {
    showError('姓名或部门填写过长，请核对后提交。');
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = '正在提交…';
  showError('');
  try {
    const response = await fetch('/api/enrollment/requests', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name, department })
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '提交失败，请稍后重试。'));
    showRequest(payload);
  } catch (error) {
    showError(error.message || '提交失败，请稍后重试。');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '提交领取申请';
  }
});

function filenameFromDisposition(disposition) {
  const utf8 = disposition?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]).replaceAll(/[\\/]/g, '_'); } catch { /* use fallback */ }
  }
  const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].replaceAll(/[\\/]/g, '_') : '即梦采集端.zip';
}

async function downloadPackage(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在准备下载…';
  showError('');
  try {
    const response = await fetch('/api/enrollment/claim', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/zip, application/octet-stream' }, body: '{}'
    });
    if (!response.ok) {
      const payload = await readJson(response);
      const error = new Error(errorMessage(payload, '下载失败，请刷新申请状态后重试。'));
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error('安装包为空，请联系管理员。');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFromDisposition(response.headers.get('Content-Disposition'));
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showRequest({ ...currentRequest, status: 'claimed', claimedAt: new Date().toISOString() });
    await refreshRequest();
  } catch (error) {
    if (error.status === 410 && currentRequest?.status === 'claimed') {
      endedClaimId = currentRequest.id;
      showRequest(currentRequest);
      showError(error.message);
      return;
    }
    showError(error.message || '下载失败，请稍后重试。');
    button.disabled = false;
    button.textContent = currentRequest?.status === 'claimed' ? '重新下载' : '下载我的采集端';
  }
}

function updateGuide() {
  const extensionAddress = `${browser}://extensions/`;
  const loadName = browser === 'edge' ? '加载解压缩的扩展' : '加载未打包的扩展程序';
  document.querySelector('#extension-address').textContent = extensionAddress;
  document.querySelector('#preview-address').textContent = extensionAddress;
  document.querySelector('#preview-browser').textContent = browser === 'edge' ? 'Edge' : 'Chrome';
  document.querySelector('#load-button-name').textContent = loadName;
  document.querySelector('#load-button-preview').textContent = loadName;
  document.querySelector('#unzip-copy').textContent = os === 'mac' ?
    '下载后双击 ZIP 完整解压。不要在 ZIP 预览窗口中安装。' :
    '下载后右键选择“全部解压缩”。不要在 ZIP 预览窗口中安装。';
  document.querySelector('#assistant-file').textContent = os === 'mac' ? 'Mac-双击安装.command' : 'Windows-双击安装.cmd';
  document.querySelector('.extensions-illustration').setAttribute('aria-label', `操作示意：在 ${browser === 'edge' ? 'Edge' : 'Chrome'} 扩展管理页面中打开开发者模式`);
  document.querySelector('.picker-illustration').setAttribute('aria-label', `操作示意：点击${loadName}，再选中包含 manifest.json 的整个文件夹`);
  document.querySelectorAll('[data-browser]').forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.browser === browser)); });
  document.querySelectorAll('[data-os]').forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.os === os)); });
}

document.querySelectorAll('[data-browser]').forEach((button) => button.addEventListener('click', () => {
  browser = button.dataset.browser;
  updateGuide();
}));
document.querySelectorAll('[data-os]').forEach((button) => button.addEventListener('click', () => {
  os = button.dataset.os;
  updateGuide();
}));
document.querySelector('#copy-address').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const address = `${browser}://extensions/`;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(address);
      copied = true;
    }
  } catch { /* HTTP pages may not have clipboard permission. */ }
  if (!copied) {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#extension-address'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    try { copied = document.execCommand('copy'); } catch { /* leave the address selected */ }
  }
  button.textContent = copied ? '已复制' : `已选中，按 ${os === 'mac' ? '⌘' : 'Ctrl'}+C`;
  setTimeout(() => { button.textContent = '复制地址'; }, 2500);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (currentRequest?.status === 'pending' || currentRequest?.status === 'claimed' && currentRequest.collector && !currentRequest.collector.online)) refreshRequest();
});

updateGuide();
refreshRequest(true);
