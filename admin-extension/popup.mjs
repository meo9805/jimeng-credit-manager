import { readJimengPage } from './page-reader.mjs';
import { summarizeRead, diagnosticEvent } from './observer.mjs';
import { readPlatformPrices, priceDraft, syncPlatformPrices } from './platform-prices.mjs';

const LOG_KEY = 'adminObserverDiagnosticsV1';
const PRICE_KEY = 'adminObserverPriceDraftV1';
const JIMENG_ORIGIN = 'https://jimeng.jianying.com';
const statusNode = document.getElementById('status');
const checkButton = document.getElementById('check');
const overviewNode = document.getElementById('overview');
const spacesNode = document.getElementById('spaces');
const logsNode = document.getElementById('log-list');
const priceStatusNode = document.getElementById('price-status');
const readPricesButton = document.getElementById('read-prices');
const syncPricesButton = document.getElementById('sync-prices');
document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

async function activeTab() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  return tab?.id && tab.url ? tab : null;
}
async function managementOrigin() {
  try {
    const response = await fetch(chrome.runtime.getURL('management-origin.json'));
    const configured = (await response.json()).origin;
    const url = new URL(configured);
    return ['http:','https:'].includes(url.protocol) && url.origin === configured &&
      !url.username && !url.password ? configured : null;
  } catch { return null; }
}
async function storedPriceDraft() {
  try { return priceDraft((await chrome.storage.local.get(PRICE_KEY))[PRICE_KEY]); }
  catch { return null; }
}
async function refreshPriceDraft() {
  const [draft,configured,tab] = await Promise.all([storedPriceDraft(),managementOrigin(),activeTab()]);
  let origin = null;
  try { origin = new URL(tab?.url).origin; } catch { /* No tab URL is available. */ }
  readPricesButton.hidden = origin !== JIMENG_ORIGIN;
  syncPricesButton.hidden = !draft || origin !== configured;
  if (draft) priceStatusNode.textContent = origin === configured ?
    `已读取 ${draft.products.length} 款套餐，可同步管理台。` :
    `已读取 ${draft.products.length} 款套餐。切到管理台后点击同步。`;
  else if (origin !== JIMENG_ORIGIN) priceStatusNode.textContent = '请在即梦页面读取套餐价格。';
}

const codeLabels = {
  account_context_changed: '账号刚切换，请再检查一次',
  account_read_recovered: '页面恢复后读取成功',
  credit_api_unavailable: '积分接口不可用',
  credit_balance_unavailable: '余额接口没有有效结果',
  credit_history_partial: '部分流水未查全',
  page_login_required: '请先登录即梦',
  page_not_ready: '即梦页面尚未就绪',
  team_discovery_partial: '部分团队未查全',
  not_jimeng_page: '请切换到即梦页面',
  tab_unavailable: '没有可检查的标签页',
  injection_failed: '无法读取页面，请刷新即梦后重试',
  invalid_result: '页面未返回检查结果',
};

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
}
function date(value) {
  if (value === null || value === undefined || value === '') return '—';
  const epoch = Number(value);
  const parsed = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch < 1e12 ? epoch * 1000 : epoch) : new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—';
}
function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.className = `status ${isError ? 'error' : 'ok'}`;
}
function appendList(details, title, items) {
  const heading = element('div', 'line', title);
  const list = element('ul', 'detail-list');
  for (const item of items) list.append(element('li', '', item));
  details.append(heading, list);
}
function renderSpace(item) {
  const scope = item.accountType === 'personal' ? '个人钱包' : item.ledgerScope === 'team_total' ? '团队总额' : '成员额度';
  const title = item.accountType === 'team' ? item.teamName || '即梦团队' : item.displayName || '即梦账号';
  const box = element('section', 'space');
  const heading = element('h2');
  heading.append(element('span', '', title), element('small', '', scope));
  box.append(heading);
  const numbers = element('div', 'numbers');
  const balance = item.accountType === 'team' && item.ledgerScope === 'team_total' ? item.teamTotalCredit : item.balance;
  numbers.append(element('strong', '', number(balance)), element('span', 'muted', '积分'));
  box.append(numbers);
  const recordCount = Array.isArray(item.records) ? item.records.length : 0;
  const memberCount = Array.isArray(item.teamSnapshot?.members) ? item.teamSnapshot.members.length : null;
  const facts = [item.membershipPlan || '会员未识别', `本次流水 ${recordCount} 条`];
  if (memberCount !== null) facts.push(`成员 ${memberCount} 人`);
  box.append(element('div', 'line', facts.join(' · ')));
  if (item.membershipExpiresAt) box.append(element('div', 'line', `会员有效至 ${date(item.membershipExpiresAt)}`));
  const details = element('details');
  details.append(element('summary', '', '查看检查详情'));
  details.append(element('div', 'line', `平台 ID ${item.userId} · ${item.teamId ? `团队 ID ${item.teamId}` : '个人空间'}`));
  if (item.accountType === 'team' && item.ledgerScope === 'team_total') {
    details.append(element('div', 'line', `本人额度 ${number(item.balance)} 分 · 团队总额 ${number(item.teamTotalCredit)} 分`));
  }
  const batches = item.accountType === 'team' && item.ledgerScope === 'team_total' ? item.teamCreditBatches : item.creditBatches;
  if (Array.isArray(batches) && batches.length) {
    appendList(details, `积分批次 ${batches.length} 笔`, batches.slice(0, 12).map(batch =>
      `${({subscription:'会员', gift:'赠送', purchase:'充值'})[batch.kind] || '积分'} ${number(batch.amount)} 分 · ${batch.expiresAt ? `${date(batch.expiresAt)} 到期` : '无到期时间'}`));
  }
  if (recordCount) appendList(details, `最近流水（展示 ${Math.min(recordCount, 8)} 条）`, item.records.slice(0, 8).map(record =>
    `${record.title || record.historyType || '积分变动'} · ${number(record.amount)} 分 · ${date(record.createTime)}`));
  if (Array.isArray(item.diagnosticCodes) && item.diagnosticCodes.length) {
    details.append(element('div', 'line', item.diagnosticCodes.map(code => codeLabels[code] || '其他读取问题').join('；')));
  }
  box.append(details);
  return box;
}
function renderSummary(summary) {
  overviewNode.hidden = false;
  overviewNode.textContent = `读到 ${summary.spaceCount} 个空间 · 其中团队 ${summary.teamCount} 个 · 本次流水 ${summary.recordCount} 条`;
  spacesNode.replaceChildren(...summary.spaces.map(renderSpace));
  if (summary.status === 'ok') setStatus('本机检查完成');
  else if (summary.status === 'partial') setStatus(`本机检查部分完成${summary.codes.length ? `：${summary.codes.map(code => codeLabels[code] || '读取异常').join('；')}` : ''}`);
  else setStatus(summary.status === 'login_required' ? '请先登录即梦' :
    summary.codes.map(code => codeLabels[code] || '读取异常').join('；') || '本机检查失败', true);
}
function renderLogs(events) {
  logsNode.replaceChildren(...events.map(event => {
    const label = event.status === 'ok' ? '完成' : event.status === 'partial' ? '部分完成' : event.status === 'login_required' ? '未登录' : '失败';
    const note = event.codes.map(code => codeLabels[code] || '读取异常').join('；');
    return element('li', '', `${date(event.at)} · ${label} · ${event.spaceCount} 空间 / ${event.recordCount} 流水 · ${event.elapsedMs}ms${note ? ` · ${note}` : ''}`);
  }));
  if (!events.length) logsNode.append(element('li', '', '暂无记录'));
}
async function readLogs() {
  try {
    const saved = await chrome.storage.local.get(LOG_KEY);
    if (!Array.isArray(saved[LOG_KEY])) return [];
    return saved[LOG_KEY].slice(0, 30).map(item => {
      const time = new Date(item?.at);
      return diagnosticEvent(item, item?.elapsedMs, Number.isFinite(time.valueOf()) ? time : new Date());
    });
  } catch { return []; }
}
async function saveLog(summary, elapsedMs) {
  const event = diagnosticEvent(summary, elapsedMs);
  const logs = [event, ...(await readLogs())].slice(0, 30);
  renderLogs(logs);
  try { await chrome.storage.local.set({[LOG_KEY]: logs}); }
  catch { /* The current result stays visible even if browser storage is unavailable. */ }
}

checkButton.addEventListener('click', async () => {
  checkButton.disabled = true;
  setStatus('正在检查即梦页面…');
  overviewNode.hidden = true;
  spacesNode.replaceChildren();
  const start = performance.now();
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id) throw new Error('tab_unavailable');
    let origin;
    try { origin = new URL(tab.url).origin; } catch { origin = null; }
    if (origin !== JIMENG_ORIGIN) throw new Error('not_jimeng_page');
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: {tabId: tab.id}, world: 'MAIN', func: readJimengPage, args: [{collectAllSpaces: true}],
      });
    } catch { throw new Error('injection_failed'); }
    const raw = results?.[0]?.result;
    if (!raw || typeof raw !== 'object' || !['ok', 'error', 'login_required'].includes(raw.status)) throw new Error('invalid_result');
    const summary = summarizeRead(raw);
    renderSummary(summary);
    await saveLog(summary, performance.now() - start);
  } catch (error) {
    const code = Object.hasOwn(codeLabels, error?.message) ? error.message : 'injection_failed';
    setStatus(codeLabels[code], true);
    await saveLog({status: 'error', codes: [code]}, performance.now() - start);
  } finally {
    checkButton.disabled = false;
  }
});

readLogs().then(renderLogs);
void refreshPriceDraft();

readPricesButton.addEventListener('click', async () => {
  readPricesButton.disabled = true;
  priceStatusNode.textContent = '正在读取平台价格…';
  try {
    const tab = await activeTab();
    if (!tab || new URL(tab.url).origin !== JIMENG_ORIGIN) throw new Error('not_jimeng_page');
    const result = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:readPlatformPrices});
    const raw = result?.[0]?.result;
    const draft = raw?.ok ? priceDraft(raw) : null;
    if (!draft) throw new Error(raw?.reason || 'price_fields_missing');
    await chrome.storage.local.set({[PRICE_KEY]:draft});
    priceStatusNode.textContent = `已读取 ${draft.products.length} 款套餐。切到管理台后点击同步。`;
  } catch (error) {
    priceStatusNode.textContent = ({
      not_jimeng_page:'请先打开即梦页面', page_not_ready:'即梦页面尚未就绪',
      price_api_unavailable:'即梦价格接口暂不可用', price_fields_missing:'价格数据不完整',
    })[error?.message] || '读取价格失败，请刷新即梦后重试';
  } finally { readPricesButton.disabled = false; }
});

syncPricesButton.addEventListener('click', async () => {
  syncPricesButton.disabled = true;
  priceStatusNode.textContent = '正在同步价格…';
  try {
    const [draft, configured, tab] = await Promise.all([storedPriceDraft(), managementOrigin(), activeTab()]);
    if (!draft) throw new Error('price_draft_missing');
    if (!configured) throw new Error('management_origin_missing');
    if (!tab || new URL(tab.url).origin !== configured) throw new Error('wrong_management_tab');
    const result = await chrome.scripting.executeScript({
      target:{tabId:tab.id},world:'MAIN',func:syncPlatformPrices,args:[draft,configured],
    });
    const outcome = result?.[0]?.result;
    if (outcome?.ok !== true) throw new Error(outcome?.reason || 'admin_unavailable');
    await chrome.storage.local.remove(PRICE_KEY);
    syncPricesButton.hidden = true;
    priceStatusNode.textContent = `已同步 ${draft.products.length} 款套餐价格`;
  } catch (error) {
    priceStatusNode.textContent = ({
      price_draft_missing:'价格已过期，请返回即梦重新读取', management_origin_missing:'请从管理台重新下载观察版',
      wrong_management_tab:'请先切到下载插件的管理台页面', admin_login_required:'请先登录管理台',
      admin_rejected:'管理台未接受价格数据', admin_unavailable:'管理台暂时无法连接',
    })[error?.message] || '同步失败，请稍后重试';
  } finally { syncPricesButton.disabled = false; }
});
