import { minorUnits } from './amount.js';
import { billingRecord } from './billing.js';
import { maxOffset } from './pagination.js';
import { statementPath, statementQuery } from './statement.js';
import { dateTimeValue, moscowClock } from './statement-calendar.js';

const number = new Intl.NumberFormat('ru-RU');
const dayLength = 86400000;
const limit = 50;
const nominalCurrencies = new Map([
  ['643', 'RUB'], ['810', 'RUB'], ['RUR', 'RUB'], ['840', 'USD'], ['978', 'EUR'], ['156', 'CNY'],
]);

export function amountUnits(amount) {
  const value = amount && typeof amount === 'object' ? amount.value ?? amount.amount : amount;
  const text = String(value ?? '').trim().replace(/^−/, '-');
  if (!text.startsWith('-')) return minorUnits(text);
  const units = minorUnits(text.slice(1));
  return units === null ? null : -units;
}

function currencyCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return nominalCurrencies.get(code) ?? (code || undefined);
}

export function dashboardMoney(units, currency) {
  if (units == null) return '—';
  const magnitude = units < 0n ? -units : units;
  const fraction = magnitude % 100n;
  const value = number.format(magnitude / 100n) + (fraction ? ',' + String(fraction).padStart(2, '0') : '');
  return (units < 0n ? '−' : '') + value + '\u00a0' + (currency === 'RUB' ? '₽' : currency);
}

export function dashboardDay(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return dateTimeValue(moscowClock(new Date(time))).slice(0, 10);
}

function calendarDay(date) {
  return dateTimeValue(date).slice(0, 10);
}

function magnitude(amount) {
  return amount < 0n ? -amount : amount;
}

function statementOperation(item) {
  const kind = String(item.typeOfOperation ?? '').toLowerCase();
  const counterparty = item.counterParty ?? item.counterparty;
  const other = kind === 'credit' ? item.payer : item.receiver;
  const date = item.operationDate ?? item.authorizationDate;
  const amount = item.accountAmount ?? item.operationAmount ?? item.rubleAmount;
  const units = amountUnits(amount);
  return {
    kind, date, day: dashboardDay(date), units: units === null ? null : magnitude(units),
    currency: currencyCode(amount?.currency ?? item.currency ?? (amount === item.rubleAmount && amount != null ? 'RUB' : undefined)),
    party: other?.name || counterparty?.name || other?.inn || counterparty?.inn,
    purpose: item.payPurpose ?? item.description,
  };
}

function summarizeStatement(balance, operations, start, days) {
  const timeline = Array.from({ length: days }, (_, index) => ({
    day: calendarDay(new Date(start.getTime() + index * dayLength)), credit: 0n, debit: 0n, balance: null,
  }));
  const byDay = new Map(timeline.map(row => [row.day, row]));
  let complete = true;
  for (const operation of operations) {
    const day = byDay.get(operation.day);
    if (!day && operation.day) continue;
    if (!day || operation.units === null || !['credit', 'debit'].includes(operation.kind)) {
      complete = false;
      continue;
    }
    day[operation.kind] += operation.units;
  }
  const bankDays = new Map((Array.isArray(balance?.balances) ? balance.balances : [])
    .filter(item => item && typeof item === 'object').map(item => [dashboardDay(item.date), item]));
  const opening = amountUnits(balance?.openingBalance ?? balance?.balanceIn) ??
    amountUnits(bankDays.get(timeline[0].day)?.openingBalance ?? bankDays.get(timeline[0].day)?.balanceIn);
  const closing = amountUnits(balance?.closingBalance ?? balance?.balanceOut);
  const total = kind => complete ? timeline.reduce((sum, day) => sum + day[kind], 0n) : null;
  const credit = total('credit');
  const debit = total('debit');
  let current = opening ?? (closing !== null && complete ? closing - credit + debit : null);
  for (const row of timeline) {
    const item = bankDays.get(row.day);
    const reported = amountUnits(item?.closingBalance ?? item?.balanceOut);
    current = reported ?? (complete && current !== null ? current + row.credit - row.debit : null);
    row.balance = current;
  }
  if (closing !== null) timeline.at(-1).balance = closing;
  const currencies = new Set(operations.map(item => item.currency).filter(Boolean));
  for (const name of ['openingBalance', 'closingBalance', 'balanceIn', 'balanceOut', 'credit', 'debit']) {
    const code = currencyCode(balance?.[name]?.currency);
    if (code) currencies.add(code);
  }
  if (currencies.size > 1) throw new Error('Выписка содержит суммы в разных валютах счёта.');
  const recent = operations.filter(item => !item.day || byDay.has(item.day))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 5);
  return {
    timeline, complete, opening, closing: timeline.at(-1).balance, recent,
    currency: currencies.values().next().value ?? 'RUB',
    credit: amountUnits(balance?.credit) ?? credit,
    debit: amountUnits(balance?.debit) ?? debit,
  };
}

export async function loadDashboardFinance(request, account, days, signal, now = new Date()) {
  const start = moscowClock(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const query = statementQuery({
    accountNumber: account, from: dateTimeValue(start), categories: '', inns: '', ucid: '', operationStatus: 'Transaction', withBalances: true,
  });
  query.to = now.toISOString();
  const cursors = new Set();
  const operationIds = new Set();
  const operations = [];
  let balances;
  let cursor;
  do {
    const params = { ...query, limit: 1000 };
    if (cursor) {
      params.cursor = cursor;
      delete params.withBalances;
    }
    const page = billingRecord(await request(statementPath, { query: params, signal }), 'operations', 'statement');
    signal.throwIfAborted();
    if (!Array.isArray(page?.operations) || page.operations.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('В ответе прокси нет списка операций выписки.');
    }
    if (!cursor) balances = page.balances;
    for (const item of page.operations) {
      if (String(item.operationStatus ?? 'transaction').toLowerCase() !== 'transaction') continue;
      const id = typeof item.operationId === 'string' && item.operationId.toLowerCase();
      if (id) {
        if (operationIds.has(id)) throw new Error('В выписке повторяются операции. Обновите данные.');
        operationIds.add(id);
      }
      operations.push(statementOperation(item));
    }
    cursor = page.nextCursor || undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 100 || cursors.has(cursor)) {
        throw new Error('Прокси вернул некорректный курсор выписки.');
      }
      cursors.add(cursor);
    }
  } while (cursor);
  return summarizeStatement(balances, operations, start, days);
}

async function readDashboardList(read, section, idField, signal, onPage) {
  const records = [];
  const ids = new Set();
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const started = performance.now();
    const { rows, total } = await read(section, offset, limit, signal);
    signal.throwIfAborted();
    for (const row of rows) {
      const id = String(row[idField] ?? '').toLowerCase();
      if (!id || ids.has(id)) throw new Error('Прокси вернул записи без ID или с повторяющимися ID. Обновите данные.');
      ids.add(id);
      records.push(row);
    }
    offset += rows.length;
    if (rows.length === 0 && total > offset) throw new Error('Прокси вернул неполный список. Обновите данные.');
    if (offset === total || (!rows.length || rows.length < limit) && !(total > offset)) return records;
    onPage?.(rows);
    if (offset > maxOffset) throw new Error('Список превышает предел пагинации.');
    const delay = started + 130 - performance.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
}

function amountTotals(rows) {
  const totals = new Map();
  for (const { amount, currency } of rows) {
    if (amount === null) return null;
    totals.set(currency, (totals.get(currency) ?? 0n) + amount);
  }
  return totals;
}

function nominalAmount(item) {
  const amount = item.amount ?? item.operationAmount;
  return {
    amount: amountUnits(amount), currency: currencyCode(amount?.currency ?? item.currency ?? item.operationCurrency) ?? 'RUB',
  };
}

function incomingRows(records, today) {
  const rows = records.map(item => {
    const date = item.transactionDate ?? item.chargeDate ?? item.authorizationDate ?? item.drawDate;
    const day = Date.parse(dashboardDay(date));
    const age = Number.isFinite(day) && day <= today ? (today - day) / dayLength : undefined;
    return { item, date, age, ...nominalAmount(item) };
  });
  rows.sort((a, b) => (b.age ?? -1) - (a.age ?? -1) || Date.parse(a.date) - Date.parse(b.date));
  return rows;
}

export async function loadDashboardIncoming(read, signal, now = new Date(), preview) {
  const today = Date.parse(calendarDay(moscowClock(now)));
  const records = await readDashboardList(read, 'incoming-transactions', 'operationId', signal, page => {
    if (preview && page.length) {
      preview(incomingRows(page, today).slice(0, 5));
      preview = undefined;
    }
  });
  const rows = incomingRows(records, today);
  const ages = [['0–1 день', 0], ['2–3 дня', 0], ['4 дня и более', 0], ['Возраст неизвестен', 0]];
  for (const { age } of rows) {
    const bucket = age === undefined ? 3 : age < 2 ? 0 : age < 4 ? 1 : 2;
    ages[bucket][1] += 1;
  }
  if (!ages.at(-1)[1]) ages.pop();
  return { count: rows.length, totals: amountTotals(rows), rows: rows.slice(0, 5), ages };
}

function failedPayments(records) {
  return records.filter(item => String(item.status).toUpperCase() === 'FAILED').map(item => ({ item, ...nominalAmount(item) }));
}

export async function loadDashboardPayments(read, signal, preview) {
  const records = await readDashboardList(read, 'payments', 'paymentId', signal, page => {
    if (!preview) return;
    const rows = failedPayments(page);
    if (rows.length) {
      preview(rows.slice(0, 5));
      preview = undefined;
    }
  });
  const rows = failedPayments(records);
  return { count: rows.length, totals: amountTotals(rows), rows: rows.slice(0, 5) };
}

export async function loadDashboardDeals(read, account, signal) {
  const records = await readDashboardList(read, 'deals', 'dealId', signal);
  const status = [['Подтверждены', 0], ['В процессе', 0]];
  for (const item of records) {
    if (String(item.accountNumber ?? '').trim() !== account) continue;
    const code = String(item.status).toUpperCase();
    if (code === 'ACCEPTED') status[0][1] += 1;
    if (code === 'IN_PROGRESS') status[1][1] += 1;
  }
  return { count: status[0][1] + status[1][1], status };
}
