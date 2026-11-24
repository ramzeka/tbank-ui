import { initIdentification } from './identify.js';
import { beneficiaryName, initBeneficiaries, listPage, scoringPath } from './beneficiaries.js';
import { bankTypes, beneficiaryTypes } from './beneficiary-schema.js';
import { dealStatus, initDeals } from './deals.js';
import { appendCopyId } from './copy-id.js';
import { billingRecord, initBillingEditor, paymentFailureReason, transfersPath } from './billing.js';
import { initPagination, maxOffset, readPage } from './pagination.js';
import { formatAmount } from './amount.js';
import { appendTransferRow, fetchTransfer, fetchTransfers, initBeneficiaryTransfers, transferColumns, transferDetails } from './transfers.js';
import { initStatement, statementPath } from './statement.js';
import { decorateFormLabels, recordDetails, tableCell as cell, tableHeaders } from './record-details.js';
import { initDashboard } from './dashboard.js';

const $ = (id) => document.getElementById(id);
const defaultPrefix = '/api/v1/nominal-accounts';
const defaultPageSize = 50;
const transactionReadInterval = 130;
const pageSizes = [10, 25, defaultPageSize];
const searchFields = ['item-id', 'deal-search-id', 'transaction-search-id', 'payment-search-id', 'transfer-search-id'];
const countFormat = new Intl.NumberFormat('ru-RU');
const storageKey = 'nominal-accounts-settings';
const environmentKey = storageKey + ':environment';
const connectionKey = environment => storageKey + ':' + environment;
const environmentLabels = {
  dev: ['DEV', 'Разработка'],
  stage: ['STAGE', 'Предпродакшен'],
  prod: ['PROD', 'Рабочая среда'],
  mock: ['Моки', 'Локальный стенд'],
  custom: ['Прокси', 'Ручная настройка запуска'],
};
const mutationKeyPrefix = 'nominal-accounts-pending:';
const mutationRetryAdvice = ' Результат записи неизвестен. Для повтора используйте те же данные в том же профиле браузера.';
const sections = {
  dashboard: { title: 'Обзор счёта' },
  beneficiaries: {
    title: 'Бенефициары и реквизиты', listTitle: 'Бенефициары',
    description: 'Список бенефициаров, их данные, реквизиты, баланс, холды, переводы и скоринг', pageSizes: [...pageSizes, 100],
    listKeys: ['beneficiaries', 'beneficiaryList'], recordKeys: ['beneficiaryId', 'firstName', 'lastName'],
  },
  'incoming-transactions': {
    title: 'Пополнения', listTitle: 'Пополнения',
    description: 'Неидентифицированные пополнения номинального счёта, данные пополнений, идентификация', pageSizes,
    listKeys: ['incomingTransactions', 'transactions', 'operations', 'payments'], recordKeys: ['operationId', 'paymentPurpose', 'payerName'],
  },
  payments: {
    title: 'Платежи', listTitle: 'Платежи',
    description: 'Исходящие платежи по номинальным счетам', pageSizes,
    listKeys: ['payments'], recordKeys: ['paymentId'],
  },
  transfers: {
    title: 'Переводы', listTitle: 'Переводы',
    description: 'Переводы между виртуальными счетами бенефициаров', pageSizes,
  },
  deals: {
    title: 'Сделки и этапы', listTitle: 'Сделки',
    description: 'Сделки по номинальным счетам, этапы, реципиенты и депоненты', pageSizes,
    listKeys: ['deals'], recordKeys: ['dealId', 'accountNumber', 'status'],
  },
  statement: {
    title: 'Выписка по счёту', description: 'Операции по счёту за выбранный период',
  },
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const billingFilterKeys = {
  payments: ['beneficiaryId', 'dealId'],
  transfers: ['fromBeneficiaryId', 'toBeneficiaryId', 'dealId'],
};
let config;
let section = 'dashboard';
let session;
let expiryTimer;
let activeRequest;
let transactionSearch;
let transactionTrigger;
let billingRequest;
let billingTrigger;
let payment;
let retryingPayment = false;
const paymentRetries = new Map();
let billingFilters = {};
let page;
const pagination = initPagination($('pagination'), (offset, limit) => load(offset, limit));
const serverRun = document.querySelector('meta[name="tbank-run"]')?.content;
const proxyConfiguration = responseJson(document.querySelector('meta[name="tbank-proxy-environments"]')?.content);
const proxySource = proxyConfiguration?.source ?? 'proxy.cfg';
const proxyOrigins = proxyConfiguration?.origins ?? {};
const proxyPaths = proxyConfiguration?.paths ?? {};
const proxyPrefixes = proxyConfiguration?.prefixes ?? {};
const configuredEnvironments = Object.keys(environmentLabels).filter(name => Object.hasOwn(proxyOrigins, name));
let selectedEnvironment = configuredEnvironments[0] ?? '';
let serverStopped = false;

function serviceUrl(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error('Укажите HTTPS-адрес без логина, пароля и фрагмента.');
  }
  return url;
}

function environmentRoute(environment) {
  return {
    proxy: proxyOrigins[environment] ? proxyOrigins[environment] + (proxyPaths[environment] || '/') : '',
    prefix: proxyPrefixes[environment] ?? defaultPrefix,
  };
}

function parseSettings(values, environment) {
  if (!proxyOrigins[environment]) throw new Error('Укажите адрес окружения в proxy.cfg и перезапустите сервер.');
  const { proxy, prefix } = environmentRoute(environment);
  const bankAccountId = (values.bankAccountId ?? '').trim();
  if (bankAccountId && !uuid.test(bankAccountId)) {
    throw new Error('Укажите bankAccountId в формате UUID.');
  }
  const accountNumber = (values.accountNumber ?? '').trim();
  if (accountNumber && !/^(?:\d{20}|\d{22})$/.test(accountNumber)) {
    throw new Error('Введите номер номинального счёта из 20 или 22 цифр.');
  }
  return { environment, proxy, prefix, bankAccountId, accountNumber };
}

function hasPendingMutations() {
  return [localStorage, sessionStorage].some(storage =>
    Object.keys(storage).some(key => key.startsWith(mutationKeyPrefix)));
}

function updateControls() {
  $('token-login').disabled = serverStopped || !config || Boolean(session);
  $('token-form').hidden = Boolean(session);
  $('logout').hidden = !session;
  $('settings-badge').hidden = !config;
  const canOpenBeneficiary = Boolean(session) && section === 'beneficiaries';
  $('beneficiary-create').hidden = !canOpenBeneficiary;
  $('detail-form').hidden = !canOpenBeneficiary;
  beneficiaryWorkspace.setEnabled(canOpenBeneficiary);
  const canOpenDeal = Boolean(session) && section === 'deals';
  $('deal-create').hidden = !canOpenDeal;
  $('deal-search').hidden = !canOpenDeal;
  dealsWorkspace.setEnabled(canOpenDeal);
  const canOpenPayment = Boolean(session) && section === 'payments';
  const canOpenTransfer = Boolean(session) && section === 'transfers';
  const filterCount = Object.keys(billingFilters[section] ?? {}).length;
  $('payment-search').hidden = !canOpenPayment;
  $('billing-filter-button').hidden = !(canOpenPayment || canOpenTransfer);
  $('billing-filter-button').dataset.active = String(filterCount > 0);
  $('billing-filter-count').hidden = !filterCount;
  $('billing-filter-count').textContent = filterCount || '';
  $('transfer-search').hidden = !canOpenTransfer;
  $('billing-create').hidden = !(canOpenPayment || canOpenTransfer);
  const billingBusy = Boolean(billingRequest);
  $('billing-filter-button').disabled = $('payment-search-id').disabled = $('payment-search-open').disabled = billingBusy;
  $('transfer-search-id').disabled = $('transfer-search').querySelector('button').disabled = $('billing-create').disabled = billingBusy;
  $('payment-retry').hidden = payment?.status !== 'FAILED' || !uuid.test(payment.dealId) || paymentRetries.has(payment.paymentId.toLowerCase());
  $('payment-retry').disabled = billingBusy;
  $('payment-back').disabled = retryingPayment;
  const searching = Boolean(transactionSearch);
  const listBusy = !session || Boolean(activeRequest) || searching;
  $('transaction-search').hidden = !session || section !== 'incoming-transactions';
  $('transaction-search-id').disabled = searching;
  $('transaction-search-open').disabled = listBusy;
  $('transaction-search-cancel').hidden = !searching;
  $('result').inert = searching;
  $('pagination').hidden = !session;
  $('refresh').disabled = listBusy;
  pagination.updateControls(listBusy);
}

function showStatus(id, message, state = 'idle') {
  const status = $(id);
  status.dataset.state = state;
  status.textContent = message;
}

function clearResults(message) {
  activeRequest?.abort();
  activeRequest = undefined;
  dashboardWorkspace.reset();
  statementWorkspace.reset();
  cancelTransactionSearch();
  closeTransaction();
  closeBillingRecord();
  billingEditor.close();
  $('billing-filters-dialog').close();
  page = undefined;
  pagination.render(page);
  $('identify-feedback').textContent = '';
  $('deal-list-feedback').textContent = '';
  $('billing-list-feedback').textContent = '';
  $('result').replaceChildren();
  $('result').removeAttribute('aria-busy');
  showStatus('request-status', message);
  updateControls();
}

function endSession(message, state = 'idle') {
  session = undefined;
  identification.endSession();
  beneficiaryWorkspace.close();
  clearTokenInput();
  for (const id of searchFields) $(id).value = '';
  $('billing-filters-form').reset();
  billingFilters = {};
  paymentRetries.clear();
  clearInterval(expiryTimer);
  $('token-expiry').hidden = true;
  $('token-expiry').textContent = '';
  showStatus('session-status', message, state);
  clearResults('Войдите в настройках подключения, чтобы загрузить данные.');
  if (state === 'error') $('settings-link').focus();
}

function stopServer(message) {
  serverStopped = true;
  endSession(message, 'error');
  $('app-layout').inert = true;
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
    $('billing-filters-dialog').close();
    if (transactionSearch) {
      cancelTransactionSearch();
      updateControls();
    }
    if (billingRequest && !retryingPayment) {
      closeBillingRecord();
      updateControls();
    }
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
  const heading = beneficiaryWorkspace.editing ? 'entity-title' : sections[section].listTitle ? 'results-title' : 'section-title';
  $(heading).focus({ preventScroll: true });
}

function responseJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function methodResponse(response, raw) {
  const outer = responseJson(raw || undefined);
  const code = outer?.responseCode;
  const status = typeof code === 'number' || (typeof code === 'string' && /^\d{3}$/.test(code)) ? Number(code) : 0;
  const wrapped = Number.isInteger(status) && status >= 100 && status <= 599;
  return {
    status: response.ok && wrapped ? status : response.status,
    data: wrapped && (response.ok || status >= 400) ? responseJson(outer.responseBody) : outer,
  };
}

function apiErrorMessage(status, data) {
  const { errorCode, requestId } = data ?? {};
  const parts = ['HTTP ' + status];
  if (typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(errorCode)) parts.push(errorCode);
  if (typeof requestId === 'string' && uuid.test(requestId)) parts.push('ID запроса ' + requestId);
  const insufficientFunds = 'Недостаточно доступных средств.';
  if (status === 422 && data?.errorMessage === insufficientFunds) parts.push(insufficientFunds);
  return parts.join(' · ');
}

async function mutationSlot(prefix, url, account, method, body) {
  const input = new TextEncoder().encode(JSON.stringify([url.href, account, method, body]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return prefix + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function lockMutation(slot, action) {
  if (!navigator.locks) throw new Error('Браузер не поддерживает защиту от одновременной отправки. Используйте актуальную версию браузера.');
  return navigator.locks.request(slot, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Операция уже отправляется в другом окне. Проверьте результат после завершения запроса.');
    return action();
  });
}

function reserveMutationKey(slot) {
  let stored, legacy;
  try {
    stored = localStorage.getItem(slot);
    legacy = sessionStorage.getItem(slot);
  } catch {
    throw new Error('Браузер не может прочитать ключ операции для безопасного повтора.');
  }
  if ([stored, legacy].some(key => key !== null && !uuid.test(key)) || (stored && legacy && stored !== legacy)) {
    throw new Error('Ключ операции не удалось подтвердить. Сверьте результат предыдущей попытки.');
  }
  const key = stored ?? legacy ?? crypto.randomUUID();
  try {
    localStorage.setItem(slot, key);
    if (legacy) sessionStorage.removeItem(slot);
  } catch {
    throw new Error('Браузер не может сохранить ключ операции для безопасного повтора.');
  }
  return key;
}

async function requestApi(path, { query, signal, method = 'GET', body, idempotent = false } = {}) {
  const current = session;
  if (!current || serverStopped) throw new Error('Войдите в приложение.');
  if (method === 'GET' && path === transfersPath && !config.accountNumber) {
    throw new Error('Укажите номер номинального счёта в настройках подключения, чтобы загрузить переводы.');
  }
  const url = new URL(config.proxy);
  const prefix = path === statementPath ? '' : path === scoringPath
    ? config.prefix.replace(/\/v1\/nominal-accounts$/, '/v2/nominal-accounts')
    : config.prefix;
  url.pathname = url.pathname.replace(/\/+$/, '') + prefix + path;
  for (const [name, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      url.searchParams.delete(name);
      for (const entry of value) url.searchParams.append(name, entry);
    } else url.searchParams.set(name, value);
  }
  if (config.accountNumber && method === 'GET' && ['/incoming-transactions', '/virtual-accounts/balances',
    '/virtual-accounts/holds', '/payments', transfersPath].includes(path)) {
    url.searchParams.set('accountNumber', config.accountNumber);
  }
  const account = path === statementPath ? '' : config.bankAccountId;
  const json = JSON.stringify(body);
  const environment = config.environment;
  const relay = key => requestRelay(url, { current, account, environment, method, json, signal, key });
  if (!idempotent) return relay();
  if (config.reconcilePending && hasPendingMutations()) {
    throw new Error('Маршрут прокси изменился. Сверьте незавершённые операции перед повторной отправкой.');
  }
  const slot = await mutationSlot(mutationKeyPrefix, url, account.toLowerCase(), method, json);
  return lockMutation(slot, async () => {
    signal?.throwIfAborted();
    if (current !== session) throw new Error('Сеанс завершён.');
    const key = reserveMutationKey(slot);
    const result = await relay(key);
    try { localStorage.removeItem(slot); }
    catch { /* Keep the confirmed result even if the browser could not erase the key. */ }
    return result;
  });
}

async function requestRelay(url, { current, account, environment, method, json, signal, key }) {
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
      'X-TBank-Environment': environment,
      'X-TBank-Run': serverRun,
    };
    if (account) headers.bankAccountId = account;
    if (key) headers['Idempotency-Key'] = key;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = AbortSignal.timeout(25000);
    return fetch('/api/relay' + url.pathname + url.search, {
      method, headers, body: json,
      redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };

  let response;
  let raw;
  try {
    for (let attempt = 0; ; attempt++) {
      response = await send();
      raw = await response.text();
      if (method !== 'GET' || attempt === 2 || response.status !== 503 ||
          response.headers.get('X-TBank-Run') !== serverRun ||
          responseJson(raw)?.message !== 'Local server is busy.') break;
      await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
    }
  } catch (error) {
    if (error instanceof TypeError && !signal?.aborted && session === current) {
      const message = 'Локальный сервер недоступен. Запустите его и обновите страницу.' + (key ? mutationRetryAdvice : '');
      stopServer(message);
      throw new Error(message);
    }
    if (key && error.name === 'TimeoutError' && !signal?.aborted) {
      throw new Error('Время ожидания ответа истекло.' + mutationRetryAdvice);
    }
    throw error;
  }

  signal?.throwIfAborted();
  if (current !== session) throw new Error('Сеанс завершён.');
  if (response.headers.get('X-TBank-Run') !== serverRun) {
    const message = 'Локальный сервер перезапущен. Обновите страницу и войдите заново.';
    stopServer(message);
    throw new Error(message);
  }

  const { status, data } = methodResponse(response, raw);
  if (status < 200 || status >= 300) {
    const explanation = apiErrorMessage(status, data);
    if (status === 401) {
      const message = explanation + ' Введите новый access token.';
      endSession(message, 'error');
      throw new Error(message);
    }
    const advice = key && (status === 408 || status >= 500) ? mutationRetryAdvice : '';
    const error = new Error(explanation + advice);
    error.status = status;
    error.details = data?.errorDetails ?? data?.errors;
    throw error;
  }
  return data;
}

function openLink(label, action) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.textContent = label;
  link.addEventListener('click', action);
  return link;
}

function idCell(row, id, label, open) {
  const target = cell(row, open && uuid.test(id) ? openLink(id, open) : id || null);
  target.className = 'record-id';
  appendCopyId(target, id, label);
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

const transactionGroups = [
  { summary: true, keys: ['operationId', 'amount', 'operationAmount', 'currency', 'operationCurrency', 'transactionDate'] },
  { title: 'Данные операции' },
];

const paymentLabels = [
  ['paymentId', 'ID платежа'], ['status', 'Статус'], ['amount', 'Сумма'], ['currency', 'Валюта'],
  ['type', 'Вид платежа'], ['purpose', 'Назначение платежа'],
  ['beneficiaryId', 'ID бенефициара'], ['accountNumber', 'Номинальный счёт'], ['operationId', 'ID операции'],
  ['dealId', 'ID сделки'], ['stepId', 'ID этапа'], ['recipientId', 'ID реципиента'],
  ['bankDetails', 'Реквизиты'], ['bankDetails.type', 'Тип'], ['bankDetails.accountNumber', 'Счёт получателя'],
  ['bankDetails.name', 'Получатель'], ['bankDetails.bankName', 'Банк'], ['bankDetails.bik', 'БИК'],
  ['bankDetails.inn', 'ИНН'], ['bankDetails.kpp', 'КПП'],
  ['bankDetails.corrAccountNumber', 'Корреспондентский счёт'], ['bankDetails.cardId', 'ID карты'],
  ['bankDetails.phoneNumber', 'Телефон'], ['bankDetails.bankId', 'ID банка'],
  ['uin', 'УИН'], ['tax', 'Налог'],
  ['tax.payerStatus', 'Статус плательщика'], ['tax.kbk', 'КБК'], ['tax.oktmo', 'ОКТМО'], ['tax.evidence', 'Основание'],
  ['tax.period', 'Период'], ['tax.docNumber', 'Номер документа'], ['tax.docDate', 'Дата документа'],
  ['tax.thirdParty', 'Третье лицо'], ['tax.thirdParty.inn', 'ИНН'], ['tax.thirdParty.kpp', 'КПП'],
];
const paymentStates = new Map([
  ['SUCCEEDED', ['Исполнен', 'success']], ['FAILED', ['Ошибка', 'error']],
  ['IN_PROGRESS', ['В процессе', 'loading']], ['PENDING', ['Ожидает', 'loading']],
  ['CANCELLED', ['Отменён', 'idle']],
]);
const paymentTypes = new Map([['REGULAR', 'Обычный'], ['TAX', 'Налоговый']]);
const paymentGroups = [
  { summary: true, keys: ['paymentId', 'amount', 'currency', 'status', 'type'] },
  { title: 'Данные платежа' },
  { title: 'Реквизиты получателя', keys: ['bankDetails'], unwrap: true },
  { title: 'Налоговые реквизиты', keys: ['uin', 'tax'], unwrap: true },
];

function paymentStatus(code) {
  const [label, state] = paymentStates.get(code) ?? [code || '—', 'idle'];
  const badge = document.createElement('span');
  badge.className = 'status-pill';
  badge.textContent = label;
  badge.dataset.state = state;
  if (code) badge.title = code;
  return badge;
}

function paymentDetails(item) {
  const { paymentId, status, amount, type, bankDetails } = item;
  return recordDetails({
    ...item, paymentId, status: paymentStatus(status), amount: formatAmount(amount),
    type: paymentTypes.get(type) ?? type,
    bankDetails: bankDetails && { ...bankDetails, type: bankTypes[bankDetails.type] ?? bankDetails.type },
  }, paymentLabels, 'paymentId', paymentGroups);
}

function showPaymentRetry(id) {
  const result = $('payment-retry-result');
  const retryId = paymentRetries.get(id);
  result.hidden = !retryId;
  result.replaceChildren();
  if (retryId) {
    result.append(openLink('Открыть повторный платёж ' + retryId, () => openBillingRecord('payment', retryId, billingTrigger)));
    appendCopyId(result, retryId, 'ID повторного платежа');
  }
  showStatus('payment-feedback', retryId ? 'Повторный платёж создан.' : paymentRetries.has(id)
    ? 'Статус повтора неизвестен. Проверьте список платежей по сделке.' : '', retryId ? 'success' : 'warning');
}

async function openBillingRecord(kind, value, trigger) {
  const isPayment = kind === 'payment';
  if (!session || section !== (isPayment ? 'payments' : 'transfers') || billingRequest) return;
  const id = value.trim().toLowerCase();
  const statusId = isPayment && !$('payment-panel').hidden ? 'payment-feedback' : kind + '-search-status';
  const label = isPayment ? 'платежа' : 'перевода';
  if (!uuid.test(id)) {
    showStatus(statusId, 'Введите ID ' + label + ' в формате UUID.', 'error');
    return;
  }
  const controller = new AbortController();
  billingRequest = controller;
  showStatus(statusId, 'Загружаем данные…', 'loading');
  updateControls();
  try {
    const { signal } = controller;
    const item = isPayment
      ? billingRecord(await requestApi('/payments/' + id, { signal }), 'paymentId', 'payment')
      : await fetchTransfer(requestApi, id, signal);
    controller.signal.throwIfAborted();
    if (isPayment && (!item || String(item.paymentId).toLowerCase() !== id)) {
      throw new Error('Прокси вернул некорректные данные платежа.');
    }
    $(kind + '-data').replaceChildren(isPayment ? paymentDetails(item) : transferDetails(item));
    showStatus(statusId, '');
    if (isPayment) {
      payment = item;
      const cause = paymentFailureReason(item);
      showStatus('payment-error', cause ? 'Причина ошибки: ' + cause : '', 'error');
      showPaymentRetry(id);
    }
    billingTrigger = trigger;
    $('list-panel').hidden = true;
    $(kind + '-panel').hidden = false;
    $(kind + '-title').focus();
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error.status === 404 ? (isPayment ? 'Платёж' : 'Перевод') + ' с таким ID не найден.' : error.message;
      showStatus(statusId, message, 'error');
    }
  } finally {
    if (billingRequest === controller) {
      billingRequest = undefined;
      updateControls();
    }
  }
}

function closeBillingRecord(restoreFocus = false) {
  billingRequest?.abort();
  billingRequest = undefined;
  retryingPayment = false;
  payment = undefined;
  showStatus('payment-error', '');
  showStatus('payment-feedback', '');
  $('payment-retry-result').hidden = true;
  $('payment-retry-result').replaceChildren();
  if (restoreFocus) updateControls();
  for (const kind of ['payment', 'transfer']) {
    showStatus(kind + '-search-status', '');
    const panel = $(kind + '-panel');
    if (panel.hidden) continue;
    panel.hidden = true;
    $(kind + '-data').replaceChildren();
    $('list-panel').hidden = false;
    if (restoreFocus) (billingTrigger?.isConnected ? billingTrigger : $(kind + '-search-id')).focus();
  }
  billingTrigger = undefined;
}

async function retryPayment() {
  if (billingRequest || payment?.status !== 'FAILED' || !uuid.test(payment.dealId)) return;
  const id = payment.paymentId.toLowerCase();
  if (paymentRetries.has(id) || !confirm('Повторить платёж?\nID платежа: ' + id)) return;
  const controller = new AbortController();
  billingRequest = controller;
  retryingPayment = true;
  showStatus('payment-feedback', 'Отправляем запрос…', 'loading');
  updateControls();
  try {
    const response = await requestApi('/payments/' + id + '/retry', { method: 'POST', signal: controller.signal });
    const retryId = billingRecord(response, 'retryPaymentId', 'payment')?.retryPaymentId;
    paymentRetries.set(id, uuid.test(retryId) ? retryId : null);
    showPaymentRetry(id);
    reloadList();
  } catch (error) {
    if (!controller.signal.aborted) {
      if (!error.status || error.status === 408 || error.status >= 500) paymentRetries.set(id, null);
      const detail = paymentRetries.has(id) ? ' Проверьте список платежей по сделке перед повторной отправкой.' : '';
      showStatus('payment-feedback', error.message + detail, 'error');
    }
  } finally {
    if (billingRequest === controller) {
      billingRequest = undefined;
      retryingPayment = false;
      updateControls();
    }
  }
}

function openBillingFilters() {
  const form = $('billing-filters-form');
  const keys = billingFilterKeys[section];
  if (!keys) return;
  $('billing-filters-title').textContent = section === 'payments' ? 'Фильтры платежей' : 'Фильтры переводов';
  for (const input of form.querySelectorAll('input')) {
    input.disabled = input.closest('label').hidden = !keys.includes(input.name);
    input.value = billingFilters[section]?.[input.name] ?? '';
    input.setCustomValidity('');
  }
  $('billing-filters-dialog').showModal();
  form.elements.namedItem(keys[0]).focus();
}

function setBillingFilters(next) {
  $('billing-filters-dialog').close();
  if (!billingFilterKeys[section]?.some(key => next[key] !== billingFilters[section]?.[key])) return;
  billingFilters[section] = next;
  loadFirstPage();
}

function applyBillingFilters(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const next = {};
  for (const key of billingFilterKeys[section]) {
    const input = form.elements.namedItem(key);
    const value = input.value.trim().toLowerCase();
    input.setCustomValidity(value && !uuid.test(value) ? 'Введите ID в формате UUID.' : '');
    if (value) next[key] = value;
  }
  if (form.reportValidity()) setBillingFilters(next);
}

function openTransaction(item, trigger) {
  const identify = identification.buttonFor(item);
  const { paymentPurpose, ...data } = item;
  $('transaction-actions').replaceChildren(...(identify.disabled ? [] : [identify]));
  $('transaction-data').replaceChildren(recordDetails({ ...data, paymentPurpose }, transactionColumns, 'operationId', transactionGroups));
  transactionTrigger = trigger;
  $('list-panel').hidden = true;
  $('transaction-panel').hidden = false;
  $('transaction-title').focus();
}

function closeTransaction(restoreFocus = false) {
  if ($('transaction-panel').hidden) return;
  $('transaction-panel').hidden = true;
  $('transaction-actions').replaceChildren();
  $('transaction-data').replaceChildren();
  $('list-panel').hidden = false;
  if (restoreFocus) (transactionTrigger?.isConnected ? transactionTrigger : $('transaction-search-id')).focus();
  transactionTrigger = undefined;
}

function cancelTransactionSearch() {
  transactionSearch?.abort();
  transactionSearch = undefined;
  showStatus('transaction-search-status', '');
}

async function findTransaction(id, signal, { cached = true, onProgress } = {}) {
  const matchesId = item => typeof item.operationId === 'string' && item.operationId.toLowerCase() === id;
  const visible = cached && page?.rows.find(matchesId);
  if (visible) return visible;

  let progress = 500;
  const seen = new Set();
  for (let offset = 0; offset <= maxOffset;) {
    signal.throwIfAborted();
    const started = performance.now();
    const { rows, total } = await readList('incoming-transactions', offset, defaultPageSize, signal);
    for (const row of rows) {
      const operationId = String(row.operationId ?? '').toLowerCase();
      if (!uuid.test(operationId) || seen.has(operationId)) {
        throw new Error('Прокси вернул пополнения без ID или с повторяющимися ID.');
      }
      seen.add(operationId);
    }
    const item = rows.find(matchesId);
    if (item) return item;
    offset += rows.length;
    if (!rows.length && total > offset) throw new Error('Прокси вернул неполный список пополнений.');
    if (offset > maxOffset) throw new Error('Список превышает предел пагинации.');
    if (!rows.length || offset >= total || (rows.length < defaultPageSize && !(total > offset))) break;
    if (offset >= progress) {
      onProgress?.(countFormat.format(offset));
      progress = offset + 500;
    }
    const interval = started + transactionReadInterval - performance.now();
    if (interval > 0) await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function searchTransactions(event) {
  event.preventDefault();
  if (!session || section !== 'incoming-transactions' || transactionSearch || activeRequest) return;
  const id = $('transaction-search-id').value.trim().toLowerCase();
  if (!uuid.test(id)) {
    showStatus('transaction-search-status', 'Введите ID пополнения в формате UUID.', 'error');
    return;
  }
  const controller = new AbortController();
  transactionSearch = controller;
  showStatus('transaction-search-status', 'Ищем пополнение…', 'loading');
  updateControls();
  try {
    const item = await findTransaction(id, controller.signal, {
      onProgress: count => showStatus('transaction-search-status', 'Ищем пополнение… Проверено ' + count + ' записей.', 'loading'),
    });
    controller.signal.throwIfAborted();
    if (item) {
      showStatus('transaction-search-status', '');
      openTransaction(item, event.submitter);
    } else {
      showStatus('transaction-search-status', 'Пополнение с таким ID не найдено среди неидентифицированных операций.', 'error');
    }
  } catch (error) {
    if (!controller.signal.aborted) showStatus('transaction-search-status', error.message, 'error');
  } finally {
    if (transactionSearch === controller) {
      transactionSearch = undefined;
      updateControls();
    }
  }
}

function appendTransaction(row, item) {
  const date = item?.transactionDate ?? item?.chargeDate ?? item?.authorizationDate ?? item?.drawDate;
  const amount = item?.amount ?? item?.operationAmount;
  const currency = item?.currency ?? item?.operationCurrency;
  cell(row, date);
  cell(row, amount == null ? null : [amount, currency].filter((value) => value != null && value !== '').join(' '));

  const payer = openLink(item.payerName || 'Открыть пополнение', event => openTransaction(item, event.currentTarget));
  cell(row, payer);
  cell(row, item.paymentPurpose || null);
  row.dataset.operationId = item.operationId ?? '';
}

function render({ rows }) {
  const beneficiaries = section === 'beneficiaries';
  const deals = section === 'deals';
  const table = document.createElement('table');
  if (section === 'payments' || section === 'transfers') table.classList.add('billing-table', section + '-table');
  const labels = ({
    beneficiaries: ['Бенефициар', 'Тип', 'ИНН', 'ID'],
    'incoming-transactions': ['Дата', 'Сумма', 'Плательщик', 'Назначение платежа'],
    payments: ['ID платежа', 'Сумма', 'Получатель', 'Назначение платежа', 'Статус'],
    transfers: transferColumns,
    deals: ['ID сделки', 'Номинальный счёт', 'Статус'],
  })[section];
  tableHeaders(table, labels);
  const body = table.createTBody();
  for (const item of rows) {
    const row = body.insertRow();
    if (beneficiaries) {
      const id = item?.beneficiaryId ?? item?.id ?? '';
      const name = beneficiaryName(item ?? {});
      const open = (event) => beneficiaryWorkspace.open(id, event.currentTarget);
      cell(row, uuid.test(id) ? openLink(name, open) : name);
      cell(row, beneficiaryTypes[item?.type] ?? item?.type);
      cell(row, item?.inn);
      idCell(row, id, 'ID бенефициара');
    } else if (deals) {
      const id = item.dealId;
      const open = event => dealsWorkspace.open(id, event.currentTarget);
      idCell(row, id, 'ID сделки', open);
      cell(row, item.accountNumber);
      cell(row, dealStatus(item.status));
    } else if (section === 'payments') {
      const id = item.paymentId;
      const open = event => openBillingRecord('payment', id, event.currentTarget);
      idCell(row, id, 'ID платежа', open);
      cell(row, formatAmount(item.amount));
      cell(row, item.bankDetails?.name || bankTypes[item.bankDetails?.type] || item.beneficiaryId);
      cell(row, item.purpose);
      cell(row, paymentStatus(item.status));
    } else if (section === 'transfers') {
      appendTransferRow(row, item, (id, trigger) => openBillingRecord('transfer', id, trigger));
    } else {
      appendTransaction(row, item);
    }
  }
  $('result').replaceChildren(table);
  pagination.render(page);
  showStatus('request-status', '');
}

async function readList(name, offset, limit, signal, filters = billingFilters[name]) {
  const { listKeys, recordKeys } = sections[name];
  const query = { offset, limit, ...filters };
  if (name === 'transfers') return fetchTransfers(requestApi, query, signal);
  const data = await requestApi('/' + name, { query, signal });
  return listPage(data, listKeys, recordKeys);
}

async function load(offset = 0, limit = Number(pagination.limit.value)) {
  if (!session || activeRequest || transactionSearch) return;
  const controller = new AbortController();
  activeRequest = controller;
  $('result').setAttribute('aria-busy', 'true');
  showStatus('request-status', page ? '' : 'Загружаем данные…', 'loading');
  updateControls();
  try {
    const name = section;
    const read = position => readList(name, position, limit, controller.signal);
    const result = await readPage(read, offset, limit, page, controller.signal);
    if (controller.signal.aborted) return;
    const sameRows = page?.rows === result.rows;
    page = result;
    if (sameRows) {
      pagination.render(page);
      showStatus('request-status', '');
    } else render(page);
  } catch (error) {
    if (!controller.signal.aborted) {
      if (page) pagination.limit.value = page.limit;
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

function finishIdentification(operationId, notice) {
  closeTransaction();
  if (!notice) $('result').querySelector('[data-operation-id="' + operationId + '"]')?.remove();
  $('results-title').focus();
  showStatus('identify-feedback', notice ?? 'Пополнение идентифицировано.', notice ? 'warning' : 'success');
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? defaultPageSize;
  activeRequest?.abort();
  activeRequest = undefined;
  load(offset && !$('result').querySelector('[data-operation-id]') ? Math.max(0, offset - limit) : offset, limit);
}
const identification = initIdentification({
  request: requestApi, uuid,
  verify: (id, signal, onProgress) => findTransaction(id.toLowerCase(), signal, { cached: false, onProgress }),
  onResult: finishIdentification,
});
function reloadList() {
  activeRequest?.abort();
  activeRequest = undefined;
  return load(page?.offset ?? 0);
}
const statementWorkspace = initStatement(requestApi);
const dashboardWorkspace = initDashboard($('dashboard-panel'), {
  request: requestApi,
  read: (name, offset, limit, signal) => readList(name, offset, limit, signal, {}),
  navigate: navigateTo,
  openIncoming(item) {
    if (navigateTo('incoming-transactions')) openTransaction(item);
  },
  openPayment(id) {
    if (navigateTo('payments')) openBillingRecord('payment', id);
  },
});
const beneficiaryWorkspace = initBeneficiaries(requestApi, reloadList, initBeneficiaryTransfers(requestApi));
const dealsWorkspace = initDeals(requestApi, reloadList, () => config?.accountNumber, dealId => {
  switchSection(document.querySelector('[data-section=payments]'), { dealId });
});
const billingEditor = initBillingEditor({
  request: requestApi, accountNumber: () => config?.accountNumber,
  onCreated(isPayment, id) {
    const kind = isPayment ? 'payment' : 'transfer';
    showStatus('billing-list-feedback', isPayment ? 'Платёж создан.' : 'Перевод создан.', 'success');
    if (!uuid.test(id)) showStatus('billing-list-feedback', 'Операция создана. Найдите её в обновлённом списке.', 'success');
    reloadList();
    if (uuid.test(id)) openBillingRecord(kind, id, $('billing-create'));
  },
});

function loadFirstPage() {
  clearResults('Войдите в настройках подключения, чтобы загрузить данные.');
  if (section === 'dashboard') dashboardWorkspace.open(config?.accountNumber, Boolean(session));
  else if (section === 'statement') statementWorkspace.open(config?.accountNumber, Boolean(session));
  else if (session) load();
}

function updateSection() {
  const { title, listTitle, description, pageSizes } = sections[section];
  $('section-title').textContent = title;
  $('section-description').textContent = description ?? '';
  $('section-description').hidden = !description;
  $('data-view').dataset.section = section;
  $('dashboard-panel').hidden = section !== 'dashboard';
  $('section-data').hidden = section === 'dashboard';
  $('statement-panel').hidden = section !== 'statement';
  if (listTitle) $('results-title').textContent = listTitle;
  if (section === 'payments' || section === 'transfers') {
    $('billing-create').textContent = section === 'payments' ? 'Создать платёж' : 'Создать перевод';
  }
  if (pageSizes) pagination.setSizes(pageSizes);
}

function fillSettings() {
  $('proxy-environment').value = selectedEnvironment;
  const { proxy, prefix } = environmentRoute(selectedEnvironment);
  $('proxy').value = selectedEnvironment ? proxy.replace(/\/$/, '') : '';
  $('prefix').value = prefix;
  $('bank-account-id').value = config?.bankAccountId ?? '';
  $('account-number').value = config?.accountNumber ?? '';
  $('settings-form').querySelector('button[type=submit]').disabled = !selectedEnvironment;
  const [label, description] = environmentLabels[selectedEnvironment] ?? [];
  $('settings-environment').textContent = label ? ' · ' + label : '';
  const sources = {
    'proxy.cfg': 'Адрес и путь берутся из proxy.cfg рядом со start.cmd. Чтобы их изменить, отредактируйте настройки окружения в файле и перезапустите сервер.',
    'proxy-origin.txt': 'Адрес загружен из proxy-origin.txt. Для нескольких окружений заполните proxy.cfg рядом со start.cmd и перезапустите сервер.',
    TBANK_UI_TRUSTED_PROXY: 'Адрес задан переменной запуска TBANK_UI_TRUSTED_PROXY. Измените её перед перезапуском сервера.',
    TBANK_UI_MOCK_PROXY: 'Адрес мока задан переменной запуска TBANK_UI_MOCK_PROXY. Измените её перед перезапуском сервера.',
  };
  $('proxy-environment-help').textContent = (description ? description + '. ' : '') + sources[proxySource];
}

function fillEnvironmentOptions() {
  const select = $('proxy-environment');
  const names = proxySource === 'proxy.cfg' ? ['dev', 'stage', 'prod'] : configuredEnvironments;
  if (!configuredEnvironments.length) select.add(new Option('Выберите настроенное окружение', ''));
  for (const environment of names) {
    const origin = proxyOrigins[environment];
    const option = new Option(environmentLabels[environment][0] + ' (' + (origin ? new URL(origin).host : 'адрес не задан') + ')', environment);
    option.disabled = !origin;
    select.add(option);
  }
}

function removeLegacyUrlParameters() {
  for (const key of [storageKey, ...Object.keys(environmentLabels).map(connectionKey)]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    let saved;
    try {
      saved = JSON.parse(raw);
      const url = serviceUrl(saved.proxy);
      if (!url.href.includes('?')) continue;
      url.search = '';
      saved.proxy = url.href;
      if (hasPendingMutations()) saved.reconcilePending = true;
    } catch {
      localStorage.removeItem(key);
      continue;
    }
    localStorage.setItem(key, JSON.stringify(saved));
  }
}

function readSavedConnection(environment) {
  if (!environment) return;
  const key = connectionKey(environment);
  const profile = JSON.parse(localStorage.getItem(key));
  const legacy = profile ? undefined : JSON.parse(localStorage.getItem(storageKey));
  if (legacy) {
    const origin = serviceUrl(legacy.proxy).origin;
    const matching = configuredEnvironments.filter(name => proxyOrigins[name] === origin);
    if (matching.length !== 1 || matching[0] !== environment) return;
  }
  const saved = profile ?? legacy;
  if (!saved) return;
  const sameOrigin = serviceUrl(saved.proxy).origin === proxyOrigins[environment];
  const next = parseSettings(sameOrigin ? saved : {}, environment);
  const routeChanged = saved.proxy !== next.proxy || saved.prefix !== next.prefix;
  if ((routeChanged || saved.reconcilePending) && hasPendingMutations()) next.reconcilePending = true;
  if (JSON.stringify(next) !== JSON.stringify(profile)) localStorage.setItem(key, JSON.stringify(next));
  if (legacy) localStorage.removeItem(storageKey);
  return next;
}

function loadConnection() {
  config = undefined;
  try {
    config = readSavedConnection(selectedEnvironment);
  } catch {
    showStatus('settings-status', 'Проверьте сохранённые настройки этого окружения.', 'error');
  }
  fillSettings();
  updateControls();
}

function canChangeConnection() {
  return !retryingPayment && !billingEditor.writing && dealsWorkspace.canLeave && beneficiaryWorkspace.leaveEditor();
}

try {
  removeLegacyUrlParameters();
  const savedEnvironment = localStorage.getItem(environmentKey);
  if (configuredEnvironments.includes(savedEnvironment)) selectedEnvironment = savedEnvironment;
} catch {
  showStatus('settings-status', 'Проверьте сохранённые настройки.', 'error');
}
fillEnvironmentOptions();
loadConnection();
if (config) showStatus('request-status', 'Войдите, чтобы загрузить данные.');
$('proxy-environment').addEventListener('change', (event) => {
  const next = event.target.value;
  if (next === selectedEnvironment) return;
  if (!configuredEnvironments.includes(next) || !canChangeConnection()) {
    event.target.value = selectedEnvironment;
    return;
  }
  try {
    localStorage.setItem(environmentKey, next);
  } catch (error) {
    showStatus('settings-status', error.message, 'error');
    event.target.value = selectedEnvironment;
    return;
  }
  endSession('Войдите в окружение ' + environmentLabels[next][0]);
  selectedEnvironment = next;
  showStatus('settings-status', '');
  loadConnection();
});
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const next = parseSettings({
      bankAccountId: $('bank-account-id').value,
      accountNumber: $('account-number').value,
    }, selectedEnvironment);
    if (config?.reconcilePending && hasPendingMutations()) next.reconcilePending = true;
    const changed = JSON.stringify(next) !== JSON.stringify(config);
    if (changed && !canChangeConnection()) return;
    localStorage.setItem(connectionKey(selectedEnvironment), JSON.stringify(next));
    localStorage.setItem(environmentKey, selectedEnvironment);
    if (changed) endSession('Вход не выполнен');
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
  if (!canChangeConnection()) return;
  endSession('Локальный сеанс завершён');
  $('access-token').focus();
});
$('refresh').addEventListener('click', () => load(page?.offset));
$('detail-form').addEventListener('submit', (event) => {
  event.preventDefault();
  beneficiaryWorkspace.open($('item-id').value, event.submitter);
});
$('transaction-search').addEventListener('submit', searchTransactions);
$('transaction-search-cancel').addEventListener('click', () => {
  cancelTransactionSearch();
  updateControls();
  $('transaction-search-id').focus();
});
$('transaction-back').addEventListener('click', () => closeTransaction(true));
$('payment-search').addEventListener('submit', event => {
  event.preventDefault();
  openBillingRecord('payment', $('payment-search-id').value, event.submitter);
});
$('transfer-search').addEventListener('submit', event => {
  event.preventDefault();
  openBillingRecord('transfer', $('transfer-search-id').value, event.submitter);
});
$('billing-create').addEventListener('click', () => billingEditor.open(section === 'payments' ? 'payment' : 'transfer'));
$('payment-retry').addEventListener('click', retryPayment);
for (const kind of ['payment', 'transfer']) {
  $(kind + '-back').addEventListener('click', () => closeBillingRecord(true));
}
$('billing-filter-button').addEventListener('click', openBillingFilters);
$('billing-filters-form').addEventListener('submit', applyBillingFilters);
$('billing-filters-form').addEventListener('input', event => event.target.setCustomValidity(''));
$('billing-filters-cancel').addEventListener('click', () => $('billing-filters-dialog').close());
$('billing-filters-reset').addEventListener('click', () => setBillingFilters({}));
function switchSection(button, filters) {
  if (!canChangeConnection()) return;
  closeSettings();
  if (button.dataset.section === section) {
    if ($('list-panel').hidden) {
      if (section === 'deals') dealsWorkspace.close();
      else if (section === 'incoming-transactions') closeTransaction();
      else if (section === 'payments' || section === 'transfers') closeBillingRecord(true);
      else beneficiaryWorkspace.close();
    }
    return;
  }
  document.querySelector('#app-navigation [aria-current="true"]').removeAttribute('aria-current');
  button.setAttribute('aria-current', 'true');
  section = button.dataset.section;
  if (filters) billingFilters[section] = filters;
  updateSection();
  for (const id of searchFields) $(id).value = '';
  loadFirstPage();
  if (filters) $('results-title').focus();
}

function navigateTo(name) {
  switchSection(document.querySelector(`#app-navigation [data-section="${name}"]`));
  if (section !== name) return false;
  $('section-title').focus({ preventScroll: true });
  return true;
}

document.querySelectorAll('#app-navigation [data-section]').forEach(button => {
  button.addEventListener('click', () => switchSection(button));
});
function initNavigation() {
  const layout = $('app-layout');
  const toggle = $('navigation-toggle');
  const narrow = matchMedia('(max-width: 720px)');
  const key = 'nominal-accounts-compact-navigation';
  let preference;
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'true' || saved === 'false') preference = saved === 'true';
  } catch { /* Keep the navigation usable without persistent storage. */ }

  function render() {
    const compact = preference ?? narrow.matches;
    layout.dataset.navigation = compact ? 'compact' : 'expanded';
    const label = compact ? 'Развернуть меню' : 'Свернуть меню';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(!compact));
  }

  toggle.addEventListener('click', () => {
    preference = layout.dataset.navigation !== 'compact';
    render();
    try { localStorage.setItem(key, String(preference)); }
    catch { /* Keep the choice for the current tab. */ }
  });
  narrow.addEventListener('change', render);
  render();
}
window.addEventListener('beforeunload', event => {
  if (retryingPayment) { event.preventDefault(); event.returnValue = ''; }
});
initNavigation();
decorateFormLabels(document);
updateSection();
updateControls();

syncSettingsView();
window.addEventListener('hashchange', () => syncSettingsView(true));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateTokenTimer();
});
if (!/^[a-f0-9]{32}$/.test(serverRun ?? '')) {
  stopServer('Запустите локальный сервер и откройте приложение по его адресу.');
}
