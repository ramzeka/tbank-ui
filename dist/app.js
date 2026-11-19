import { beneficiaryName, initBeneficiaries, listPage } from './beneficiaries.js';
import { beneficiaryTypes } from './beneficiary-schema.js';

const $ = (id) => document.getElementById(id);
const defaultPrefix = '/api/v1/nominal-accounts';
const storageKey = 'nominal-accounts-settings';
const sections = {
  beneficiaries: { title: 'Бенефициары и реквизиты', description: 'Список бенефициаров, карточки и банковские реквизиты.' },
  'incoming-transactions': { title: 'Пополнения', description: 'Неидентифицированные пополнения номинального счёта.' },
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
let config;
let section = 'beneficiaries';
let session;
let expiryTimer;
let activeRequest;
let page;
let serverRun;
let serverCheck;
let serverStopped = false;

function serviceUrl(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error('Укажите HTTPS-адрес без логина, пароля и фрагмента.');
  }
  return url;
}

function parseSettings(values) {
  const proxy = serviceUrl(values.proxy);
  const bankDomains = ['tbank.ru', 'tinkoff.ru', 't-bank-app.ru'];
  if (proxy.origin === location.origin ||
      bankDomains.some((domain) => proxy.hostname === domain || proxy.hostname.endsWith('.' + domain))) {
    throw new Error('Укажите базовый адрес внутреннего прокси.');
  }
  const prefix = values.prefix.trim().replace(/\/+$/, '');
  if (!/^\/(?:[\w-]+\/)*[\w-]+$/.test(prefix)) {
    throw new Error('Укажите путь к номинальным счетам, например ' + defaultPrefix);
  }
  const bankAccountId = (values.bankAccountId ?? '').trim();
  if (bankAccountId && !uuid.test(bankAccountId)) {
    throw new Error('Укажите bankAccountId в формате UUID.');
  }
  const accountNumber = (values.accountNumber ?? '').trim();
  if (accountNumber && !/^(?:\d{20}|\d{22})$/.test(accountNumber)) {
    throw new Error('Введите номер номинального счёта из 20 или 22 цифр.');
  }
  return { proxy: proxy.href, prefix, bankAccountId, accountNumber };
}

function updateControls() {
  $('token-login').disabled = serverStopped || !config || Boolean(session);
  $('token-form').hidden = Boolean(session);
  $('logout').hidden = !session;
  $('settings-badge').hidden = !config;
  const isBeneficiarySection = section === 'beneficiaries';
  $('beneficiary-status').hidden = !isBeneficiarySection;
  $('detail-form').hidden = !isBeneficiarySection;
  $('limit').max = String(maxPageSize());
  beneficiaryWorkspace.setEnabled(Boolean(session) && isBeneficiarySection);
  for (const id of ['load', 'detail', 'previous', 'next']) {
    $(id).disabled = !session || Boolean(activeRequest) ||
      (id === 'previous' && !(page?.offset > 0)) || (id === 'next' && !page?.hasNext);
  }
}

function showStatus(id, message, state = 'idle') {
  const status = $(id);
  status.dataset.state = state;
  status.textContent = message;
}

function clearResults(message) {
  activeRequest?.abort();
  activeRequest = undefined;
  page = undefined;
  $('result').replaceChildren();
  $('pagination').hidden = true;
  $('result').removeAttribute('aria-busy');
  showStatus('request-status', message);
  updateControls();
}

function endSession(message, state = 'idle') {
  clearTokenInput();
  session = undefined;
  clearInterval(expiryTimer);
  $('token-expiry').hidden = true;
  $('token-expiry').textContent = '';
  showStatus('session-status', message, state);
  clearResults('Войдите в настройках подключения, чтобы загрузить данные.');
}

function checkServer() {
  if (serverStopped) return Promise.resolve(false);
  if (!serverCheck) {
    serverCheck = fetch('/health', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000),
    }).then(async (response) => {
      const run = await response.text();
      if (!response.ok || !/^[a-f0-9]{32}$/.test(run) || (serverRun && serverRun !== run)) {
        throw new Error('Сервер остановлен.');
      }
      serverRun = run;
      return true;
    }).catch(() => {
      serverStopped = true;
      clearInterval(serverWatch);
      endSession('Локальный сервер остановлен. Запустите start.cmd.', 'error');
      document.querySelector('.layout').inert = true;
      return false;
    }).finally(() => {
      serverCheck = undefined;
    });
  }
  return serverCheck;
}

function clearTokenInput() {
  $('access-token').value = '';
  showStatus('token-status', '');
}

const settingsHash = '#connection-settings';

function syncSettingsView(focusHeading = false) {
  const showingSettings = location.hash === settingsHash;
  const settings = $('connection-settings');
  if (!showingSettings && !settings.hidden) clearTokenInput();
  settings.hidden = !showingSettings;
  $('data-view').hidden = showingSettings;
  if (showingSettings) {
    $('settings-link').setAttribute('aria-current', 'page');
  } else {
    $('settings-link').removeAttribute('aria-current');
  }
  if (focusHeading) {
    $(showingSettings ? 'settings-title' : 'section-title').focus({ preventScroll: true });
  }
}

function closeSettings() {
  if (location.hash !== settingsHash) return;
  history.replaceState(null, '', location.pathname + location.search);
  syncSettingsView();
}

function tokenExpiry(access) {
  const parts = access.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return undefined;
  try {
    const payload = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const exp = JSON.parse(payload)?.exp;
    return typeof exp === 'number' && Number.isFinite(exp * 1000) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

const expiredMessage = 'Срок действия токена истёк. Введите новый access token.';

function updateTokenTimer() {
  if (!session) return;
  const display = $('token-expiry');
  if (session.expiresAt === undefined) {
    display.textContent = 'Срок действия неизвестен';
    display.hidden = false;
    return;
  }
  const seconds = Math.ceil((session.expiresAt - Date.now()) / 1000);
  if (seconds <= 0) {
    endSession(expiredMessage, 'error');
    return;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  display.textContent = 'До истечения: ' + (hours ? hours + ':' : '') + minutes + ':' + remainder;
  display.hidden = false;
}

function importToken(event) {
  event.preventDefault();
  if (serverStopped || !config || session) return;
  const access = $('access-token').value.trim().replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(access) || /^Bearer$/i.test(access)) {
    showStatus('token-status', 'Вставьте access token или строку Bearer <token>.', 'error');
    return;
  }
  const expiresAt = tokenExpiry(access);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    showStatus('token-status', expiredMessage, 'error');
    return;
  }
  clearTokenInput();
  session = { access, expiresAt };
  if (expiresAt !== undefined) expiryTimer = setInterval(updateTokenTimer, 1000);
  showStatus('session-status', 'Токен подключён', 'success');
  updateTokenTimer();
  if (!session) return;
  closeSettings();
  loadFirstPage();
  $('load').focus({ preventScroll: true });
}

function responseJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function methodResponse(response, raw) {
  const outer = responseJson(raw || undefined);
  const code = outer?.responseCode;
  const status = typeof code === 'number' || (typeof code === 'string' && /^\d{3}$/.test(code)) ? Number(code) : 0;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return { status, data: responseJson(outer.responseBody) };
  }
  return { status: response.status, data: outer };
}

function apiErrorMessage(status, data) {
  const messages = new Set();
  function add(value, field, depth = 0) {
    if (depth > 4 || messages.size >= 12) return;
    if (typeof value === 'string' && value.trim() && !/^\s*</.test(value)) {
      messages.add((field ? field + ' — ' : '') + value.trim().slice(0, 400));
    } else if (Array.isArray(value)) {
      for (const item of value) add(item, field, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) add(item, field ? field + '.' + name : name, depth + 1);
    }
  }
  if (typeof data === 'string') add(data);
  else {
    add(data?.errorMessage ?? data?.message ?? data?.errorDescription ?? data?.title);
    add(data?.errorDetails ?? data?.errors ?? data?.details);
  }
  const code = typeof data?.errorCode === 'string' ? ' · ' + data.errorCode : '';
  return 'HTTP ' + status + code + (messages.size ? '. ' + [...messages].join(' ') : '');
}

async function requestApi(path, { query, signal } = {}) {
  const current = session;
  if (!current || !await checkServer() || current !== session) throw new Error('Войдите в приложение.');
  const url = new URL(config.proxy);
  url.pathname = url.pathname.replace(/\/+$/, '') + config.prefix + path;
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  if (path === '/incoming-transactions' && config.accountNumber) url.searchParams.set('accountNumber', config.accountNumber);

  const send = () => {
    signal?.throwIfAborted();
    if (session !== current) throw new Error('Сеанс завершён.');
    if (current.expiresAt !== undefined && current.expiresAt <= Date.now()) {
      endSession(expiredMessage, 'error');
      throw new Error(expiredMessage);
    }
    const headers = {
      Authorization: 'Bearer ' + current.access,
      'X-TBank-Proxy-Origin': url.origin,
      'X-TBank-Run': serverRun,
    };
    if (config.bankAccountId) headers.bankAccountId = config.bankAccountId;
    const timeout = AbortSignal.timeout(25000);
    return fetch('/api/relay' + url.pathname + url.search, {
      method: 'GET', headers,
      redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };

  let response;
  try {
    response = await send();
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Локальный сервер недоступен. Проверьте, что start.cmd запущен.');
    throw error;
  }

  const raw = await response.text();
  signal?.throwIfAborted();
  if (current !== session) throw new Error('Сеанс завершён.');

  const { status, data } = methodResponse(response, raw);
  if (status < 200 || status >= 300) {
    const explanation = apiErrorMessage(status, data);
    if (status === 401) {
      const message = explanation + ' Введите новый access token.';
      endSession(message, 'error');
      throw new Error(message);
    }
    throw new Error(explanation);
  }
  return data;
}

function cell(row, value, header = false) {
  const element = document.createElement(header ? 'th' : 'td');
  if (header) element.scope = 'col';
  if (value instanceof HTMLElement) element.append(value);
  else element.textContent = value ?? '—';
  row.append(element);
  return element;
}

function openLink(label, action) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.textContent = label;
  link.addEventListener('click', action);
  return link;
}

const transactionColumns = [
  ['operationId', 'ID операции'], ['transactionDate', 'Дата транзакции'], ['chargeDate', 'Дата списания'],
  ['authorizationDate', 'Дата авторизации'], ['drawDate', 'Дата документа'], ['amount', 'Сумма'], ['currency', 'Валюта'],
  ['operationAmount', 'Сумма операции'], ['operationCurrency', 'Валюта операции'], ['payerName', 'Плательщик'],
  ['payerInn', 'ИНН плательщика'], ['payerKpp', 'КПП плательщика'], ['payerAccountNumber', 'Счёт плательщика'],
  ['payerBankName', 'Банк плательщика'], ['payerBik', 'БИК'], ['payerBankSwiftCode', 'SWIFT'],
  ['payerCorrAccountNumber', 'Корреспондентский счёт'], ['paymentPurpose', 'Назначение платежа'],
  ['documentNumber', 'Номер документа'], ['accountNumber', 'Номинальный счёт'],
];

function transactionDetails(item) {
  const grid = document.createElement('dl');
  grid.className = 'transaction-fields';
  const fields = new Map(transactionColumns);
  function add(label, value) {
    if (value == null || value === '') return;
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) add(label + ' · ' + (fields.get(key) ?? key), child);
      return;
    }
    const term = document.createElement('dt');
    term.textContent = label;
    const content = document.createElement('dd');
    content.textContent = value;
    const field = document.createElement('div');
    field.append(term, content);
    grid.append(field);
  }
  for (const [key, value] of Object.entries(item ?? {})) add(fields.get(key) ?? key, value);
  return grid;
}

function appendTransaction(body, row, item, index) {
  const date = item?.transactionDate ?? item?.chargeDate ?? item?.authorizationDate ?? item?.drawDate;
  const amount = item?.amount ?? item?.operationAmount;
  const currency = item?.currency ?? item?.operationCurrency;
  cell(row, date).className = 'transaction-date';
  cell(row, amount == null ? null : [amount, currency].filter((value) => value != null && value !== '').join(' ')).className = 'transaction-amount';

  for (const value of [item?.payerName, item?.paymentPurpose]) {
    const preview = document.createElement('span');
    preview.className = 'transaction-preview';
    preview.textContent = value || '—';
    cell(row, preview);
  }

  const details = body.insertRow();
  details.hidden = true;
  details.id = 'transaction-details-' + index;
  const container = details.insertCell();
  container.colSpan = 5;
  container.className = 'transaction-details';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'secondary transaction-toggle';
  toggle.textContent = 'Подробнее';
  toggle.setAttribute('aria-controls', details.id);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    details.hidden = !details.hidden;
    toggle.setAttribute('aria-expanded', String(!details.hidden));
    toggle.textContent = details.hidden ? 'Подробнее' : 'Свернуть';
    if (!details.hidden && !container.firstChild) container.append(transactionDetails(item));
  });
  cell(row, toggle);
}

function render(data, offset, limit) {
  const beneficiaries = section === 'beneficiaries';
  const { rows, total } = beneficiaries
    ? listPage(data, ['beneficiaries', 'beneficiaryList'], ['beneficiaryId', 'firstName', 'lastName'])
    : listPage(data, ['incomingTransactions', 'transactions', 'operations', 'payments'], ['operationId', 'paymentPurpose', 'payerName']);
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  if (!beneficiaries) table.className = 'transactions-table';
  const labels = beneficiaries
    ? ['Бенефициар', 'Тип', 'ИНН', 'ID']
    : ['Дата', 'Сумма', 'Плательщик', 'Назначение платежа', 'Детали'];
  for (const label of labels) cell(header, label, true);
  const body = table.createTBody();
  for (const [index, item] of rows.entries()) {
    const row = body.insertRow();
    if (beneficiaries) {
      const id = item?.beneficiaryId ?? item?.id ?? '';
      const name = beneficiaryName(item ?? {});
      const open = () => beneficiaryWorkspace.open(id);
      cell(row, uuid.test(id) ? openLink(name, open) : name);
      cell(row, beneficiaryTypes[item?.type] ?? item?.type);
      cell(row, item?.inn);
      cell(row, uuid.test(id) ? openLink(id, open) : id || '—').className = 'record-id';
    } else {
      appendTransaction(body, row, item, index);
    }
  }
  $('result').append(table);
  const hasNext = total === undefined ? rows.length === limit : offset + rows.length < total;
  page = { offset, limit, hasNext: hasNext && offset + limit <= 2147483647 };
  $('pagination').hidden = !offset && !page.hasNext;
  showStatus('request-status', rows.length ? 'Строки ' + (offset + 1) + '–' + (offset + rows.length) : 'Список пуст.', 'success');
}

function maxPageSize() {
  return section === 'incoming-transactions' ? 50 : 100;
}

async function load(offset = 0, limit = $('limit').valueAsNumber) {
  if (!session || activeRequest) return;
  const controller = new AbortController();
  activeRequest = controller;
  page = undefined;
  $('result').replaceChildren();
  $('pagination').hidden = true;
  $('result').setAttribute('aria-busy', 'true');
  showStatus('request-status', 'Загружаем данные…', 'loading');
  updateControls();
  try {
    const maximum = maxPageSize();
    if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
      throw new Error('Укажите от 1 до ' + maximum + ' строк.');
    }
    if ((!Number.isInteger(offset) || offset < 0 || offset > 2147483647)) {
      throw new Error('Смещение должно быть целым числом от 0 до 2147483647.');
    }
    $('offset').value = offset;
    const data = await requestApi('/' + section, { query: { offset, limit }, signal: controller.signal });
    render(data, offset, limit);
    if ($('request-status').dataset.state === 'loading') showStatus('request-status', 'Данные получены.', 'success');
  } catch (error) {
    if (!controller.signal.aborted) {
      showStatus('request-status', error.message, 'error');
    }
  } finally {
    if (activeRequest === controller) {
      activeRequest = undefined;
      $('result').removeAttribute('aria-busy');
    }
    updateControls();
  }
}

const beneficiaryWorkspace = initBeneficiaries(requestApi);

function loadFirstPage() {
  $('limit').value = 50;
  $('offset').value = 0;
  clearResults('Войдите в настройках подключения, чтобы загрузить данные.');
  if (session) load(0, 50);
}

function fillSettings() {
  $('proxy').value = config?.proxy ?? '';
  $('prefix').value = config?.prefix ?? defaultPrefix;
  $('bank-account-id').value = config?.bankAccountId ?? '';
  $('account-number').value = config?.accountNumber ?? '';
}

try {
  const saved = localStorage.getItem(storageKey);
  if (saved) config = parseSettings(JSON.parse(saved));
} catch {
  showStatus('settings-status', 'Проверьте сохранённые настройки.', 'error');
}
fillSettings();
if (config) showStatus('request-status', 'Войдите, чтобы загрузить данные.');
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const next = parseSettings({
      proxy: $('proxy').value,
      prefix: $('prefix').value,
      bankAccountId: $('bank-account-id').value,
      accountNumber: $('account-number').value,
    });
    localStorage.setItem(storageKey, JSON.stringify(next));
    if (JSON.stringify(next) !== JSON.stringify(config)) endSession('Вход не выполнен');
    config = next;
    fillSettings();
    showStatus('settings-status', 'Настройки сохранены.', 'success');
    updateControls();
    if (!$('token-login').disabled) $('access-token').focus();
  } catch (error) {
    showStatus('settings-status', error.message, 'error');
  }
});
$('token-form').addEventListener('submit', importToken);
$('logout').addEventListener('click', () => {
  endSession('Локальный сеанс завершён');
  $('access-token').focus();
});
$('list-form').addEventListener('submit', (event) => {
  event.preventDefault();
  load($('offset').valueAsNumber);
});
$('detail-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (section === 'beneficiaries') beneficiaryWorkspace.open($('item-id').value);
});
$('previous').addEventListener('click', () => load(Math.max(0, page.offset - page.limit), page.limit));
$('next').addEventListener('click', () => load(page.offset + page.limit, page.limit));
document.querySelectorAll('[data-section]').forEach((button) => {
  button.addEventListener('click', () => {
    closeSettings();
    if (button.dataset.section === section) return;
    document.querySelector('[aria-current="true"]').removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    section = button.dataset.section;
    $('section-title').textContent = sections[section].title;
    $('section-description').textContent = sections[section].description;
    $('item-id').value = '';
    loadFirstPage();
  });
});
updateControls();

syncSettingsView();
window.addEventListener('hashchange', () => syncSettingsView(true));

const serverWatch = setInterval(checkServer, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    updateTokenTimer();
    checkServer();
  }
});
checkServer();
