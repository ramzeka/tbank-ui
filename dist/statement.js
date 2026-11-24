import { formatAmount } from './amount.js';
import { billingRecord } from './billing.js';
import { appendCopyId } from './copy-id.js';
import { recordDetails, tableCell, tableHeaders } from './record-details.js';
import { dateTimeValue, initStatementCalendar, moscowClock } from './statement-calendar.js';

export const statementPath = '/api/v1/statement';
const $ = id => document.getElementById(id);
const accountPattern = /^\d{20}$/;
const countFormat = new Intl.NumberFormat('ru-RU');
const operationTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const operationTypes = new Map([['credit', 'Поступление'], ['debit', 'Списание']]);
const operationStatuses = new Map([['authorization', 'Авторизация'], ['transaction', 'Транзакция']]);
const currencies = new Map([['643', 'RUB'], ['840', 'USD'], ['978', 'EUR'], ['156', 'CNY']]);
const balanceLabels = [
  ['credit', 'Приход'], ['debit', 'Расход'], ['openingBalance', 'Входящий остаток'], ['closingBalance', 'Исходящий остаток'],
  ['balanceIn', 'Входящий остаток'], ['balanceOut', 'Исходящий остаток'], ['date', 'Дата'],
  ['creditAuthorizations', 'Авторизации прихода'], ['debitAuthorizations', 'Авторизации расхода'],
];

function monthBefore(date) {
  const start = new Date(date);
  const day = start.getUTCDate();
  start.setUTCMonth(start.getUTCMonth() - 1, 1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  start.setUTCDate(Math.min(day, end.getUTCDate()));
  return start;
}

export function statementPeriod(period, now = new Date()) {
  const end = moscowClock(now);
  let start = new Date(end);
  if (period === 'today') {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(24, 0, 0, 0);
  } else if (period === 'week') start.setUTCDate(start.getUTCDate() - 7);
  else if (period === 'previous-month') {
    end.setUTCDate(1);
    end.setUTCHours(0, 0, 0, 0);
    start = monthBefore(end);
  } else start = monthBefore(end);
  return [dateTimeValue(start), dateTimeValue(end)];
}

function isoDate(value) {
  const date = new Date(value + '+03:00');
  if (!Number.isFinite(date.getTime())) throw new Error('Укажите корректную дату и время периода.');
  return date.toISOString();
}

function listFilter(value, label) {
  const items = [...new Set(value.split(/[\s,;]+/).filter(Boolean))];
  if (items.length > 50) throw new Error(label + ' — максимум 50 значений.');
  return items;
}

export function statementQuery(values) {
  const accountNumber = values.accountNumber.trim();
  if (!accountPattern.test(accountNumber)) throw new Error('Укажите номер счёта из 20 цифр.');
  const from = isoDate(values.from);
  const to = values.to ? isoDate(values.to) : undefined;
  if (to && to <= from) throw new Error('Конец периода должен быть позже начала.');
  const categories = listFilter(values.categories, 'Категории');
  const inns = listFilter(values.inns, 'ИНН контрагентов');
  if (inns.some(inn => !/^(?:\d{10}|\d{12})$/.test(inn))) throw new Error('Введите ИНН из 10 или 12 цифр.');
  const ucid = values.ucid.trim();
  if (ucid && (!/^\d{1,19}$/.test(ucid) || BigInt(ucid) > 9223372036854775807n)) {
    throw new Error('Введите UCID карты в формате целого числа.');
  }
  const query = { accountNumber, from };
  if (to) query.to = to;
  if (categories.length) query.categories = categories;
  if (inns.length) query.inns = inns;
  if (ucid) query.ucid = ucid;
  if (values.operationStatus) query.operationStatus = values.operationStatus;
  if (values.withBalances) query.withBalances = true;
  return query;
}

function displayDate(value) {
  if (typeof value !== 'string') return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('.');
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? operationTime.format(date) : value;
}

function money(amount, fallbackCurrency) {
  const value = amount && typeof amount === 'object' ? amount.value ?? amount.amount : amount;
  const currency = String(amount?.currency ?? fallbackCurrency ?? '');
  if (value == null || value === '') return null;
  return [formatAmount(value), currencies.get(currency) ?? currency].filter(Boolean).join(' ');
}

function operationTable(operations) {
  const table = document.createElement('table');
  table.classList.add('statement-table');
  tableHeaders(table, ['Дата (МСК)', 'Операция', 'Сумма', 'Контрагент', 'Назначение', 'Статус', 'Категория', 'ID операции']);
  const body = table.createTBody();
  for (const item of operations) {
    const row = body.insertRow();
    const type = String(item.typeOfOperation ?? '').toLowerCase();
    const status = String(item.operationStatus ?? '').toLowerCase();
    const counterparty = item.counterParty ?? item.counterparty;
    const otherParty = type === 'credit' ? item.payer : type === 'debit' ? item.receiver : undefined;
    tableCell(row, displayDate(item.operationDate ?? item.authorizationDate));
    tableCell(row, operationTypes.get(type) ?? item.typeOfOperation);
    tableCell(row, money(item.accountAmount ?? item.operationAmount ?? item.rubleAmount, item.currency));
    tableCell(row, otherParty?.name || counterparty?.name || otherParty?.inn || counterparty?.inn);
    tableCell(row, item.payPurpose ?? item.description);
    tableCell(row, operationStatuses.get(status) ?? item.operationStatus);
    tableCell(row, item.category);
    const id = tableCell(row, item.operationId);
    id.className = 'record-id';
    appendCopyId(id, item.operationId, 'ID операции');
  }
  return table;
}

function renderBalances(balances) {
  const host = $('statement-balance-data');
  host.replaceChildren();
  if (balances && typeof balances === 'object' && !Array.isArray(balances)) {
    const { balances: days, ...totals } = balances;
    host.append(recordDetails(totals, balanceLabels, undefined, [{}]));
    if (Array.isArray(days) && days.length) {
      const daily = document.createElement('details');
      daily.className = 'raw-details statement-daily-balances';
      const title = document.createElement('summary');
      title.textContent = 'Балансы по дням';
      daily.append(title);
      daily.addEventListener('toggle', () => {
        if (!daily.open || daily.childElementCount > 1) return;
        for (const day of days) daily.append(recordDetails(day, balanceLabels, undefined, [{}]));
      });
      host.append(daily);
    }
  }
  $('statement-balances').hidden = !host.childElementCount;
}

export function initStatement(request) {
  const form = $('statement-form');
  const fields = $('statement-fields');
  const extra = $('statement-extra');
  const extraToggle = $('statement-extra-toggle');
  const result = $('statement-result');
  const limit = $('statement-limit');
  const previous = $('statement-prev');
  const next = $('statement-next');
  const input = name => form.elements.namedItem(name);
  const closeCalendar = initStatementCalendar();
  let active;
  let query;
  let cursors;
  let index;
  let pageLimit;

  function status(text, state = 'idle') {
    const node = $('statement-status');
    node.textContent = text;
    node.dataset.state = state;
  }

  function controls() {
    const busy = Boolean(active);
    previous.disabled = busy || !index;
    next.disabled = busy || !cursors?.[index + 1];
    limit.disabled = busy;
  }

  function clearPage() {
    active?.abort();
    active = undefined;
    cursors = [undefined];
    index = 0;
    result.replaceChildren();
    result.removeAttribute('aria-busy');
    $('statement-pages').hidden = true;
    $('statement-balances').open = false;
    renderBalances();
  }

  function fillPeriod() {
    if (input('period').value === 'custom') return;
    [input('from').value, input('to').value] = statementPeriod(input('period').value);
  }

  function setExtraOpen(open) {
    extra.hidden = !open;
    extraToggle.setAttribute('aria-expanded', String(open));
  }

  async function load(target) {
    if (!query || active) return;
    const controller = new AbortController();
    const { signal } = controller;
    active = controller;
    const cursor = cursors[target];
    const params = { ...query, limit: pageLimit };
    if (cursor) {
      params.cursor = cursor;
      delete params.withBalances;
    }
    status('Загружаем выписку…', 'loading');
    result.setAttribute('aria-busy', 'true');
    controls();
    try {
      const data = await request(statementPath, { query: params, signal });
      signal.throwIfAborted();
      const page = billingRecord(data, 'operations', 'statement');
      if (!Array.isArray(page?.operations) || page.operations.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('В ответе прокси нет списка операций выписки.');
      }
      const following = page.nextCursor || undefined;
      if (following !== undefined && (typeof following !== 'string' || following.length > 100 || cursors.slice(0, target + 1).includes(following))) {
        throw new Error('Прокси вернул некорректный курсор выписки.');
      }
      if (cursors[target + 1] !== following) cursors.splice(target + 1, cursors.length, ...(following ? [following] : []));
      index = target;
      if (!target) renderBalances(page.balances);
      result.replaceChildren(...(page.operations.length ? [operationTable(page.operations)] : []));
      $('statement-summary').textContent = 'Страница ' + countFormat.format(index + 1) + ' · операций ' + countFormat.format(page.operations.length);
      $('statement-pages').hidden = false;
      status(page.operations.length ? '' : 'Операций за этот период нет.');
    } catch (error) {
      if (!signal.aborted) status(error.message, 'error');
    } finally {
      if (active === controller) {
        active = undefined;
        result.removeAttribute('aria-busy');
        controls();
      }
    }
  }

  function apply() {
    try {
      const values = Object.fromEntries(new FormData(form));
      query = statementQuery(values);
      clearPage();
      pageLimit = Number(limit.value);
      load(0);
    } catch (error) {
      status(error.message, 'error');
    }
  }

  function reset() {
    closeCalendar();
    clearPage();
    query = undefined;
    fields.disabled = true;
    form.reset();
    setExtraOpen(false);
    limit.value = '50';
    fillPeriod();
    status('Войдите в настройках подключения, чтобы загрузить выписку.');
    controls();
  }

  extraToggle.addEventListener('click', () => setExtraOpen(extra.hidden));
  input('period').addEventListener('change', fillPeriod);
  for (const name of ['from', 'to']) input(name).addEventListener('input', () => { input('period').value = 'custom'; });
  form.addEventListener('submit', event => { event.preventDefault(); apply(); });
  limit.addEventListener('change', () => { clearPage(); pageLimit = Number(limit.value); load(0); });
  previous.addEventListener('click', () => load(index - 1));
  next.addEventListener('click', () => load(index + 1));
  reset();
  return { reset, open(account, enabled) {
    if (!enabled) return;
    fields.disabled = false;
    if (accountPattern.test(account)) {
      input('accountNumber').value = account;
      apply();
    } else status('Укажите номер счёта, чтобы получить выписку.');
  } };
}
