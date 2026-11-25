import { minorUnits } from './amount.js';
import { billingRecord } from './billing.js';
import { pageFor } from './pagination.js';
import { statementPath, statementQuery } from './statement.js';
import { dateTimeValue, moscowClock } from './statement-calendar.js';

const number = new Intl.NumberFormat('ru-RU');
const dayLength = 86400000;
const incomingLimit = 50;
const nominalCurrencies = new Map([
  ['643', 'RUB'], ['810', 'RUB'], ['RUR', 'RUB'], ['840', 'USD'], ['978', 'EUR'], ['156', 'CNY'],
]);

function amountUnits(amount) {
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
  return (units < 0n ? '−' : '') + value + (currency ? '\u00a0' + (currency === 'RUB' ? '₽' : currency) : '');
}

function dashboardDay(value) {
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
  const other = kind === 'credit' ? item.payer : kind === 'debit' ? item.receiver : undefined;
  const date = item.operationDate ?? item.authorizationDate;
  const amount = item.accountAmount ?? item.operationAmount ?? item.rubleAmount;
  const units = amountUnits(amount);
  const currency = amount === item.accountAmount ? item.accountCurrencyDigitalCode :
    amount === item.operationAmount ? item.operationCurrencyDigitalCode : 'RUB';
  return {
    kind, date, time: Date.parse(date), day: dashboardDay(date), units: units === null ? null : magnitude(units),
    currency: currencyCode(amount?.currency ?? currency ?? item.currency),
    party: other?.name || counterparty?.name || other?.inn || counterparty?.inn,
    purpose: item.payPurpose ?? item.description,
  };
}

function summarizeFinance(operations, start, days) {
  const timeline = Array.from({ length: days }, (_, index) => ({
    day: calendarDay(new Date(start.getTime() + index * dayLength)), credit: 0n, debit: 0n,
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
  const total = kind => complete ? timeline.reduce((sum, day) => sum + day[kind], 0n) : null;
  const currencies = new Set(operations.map(item => item.currency).filter(Boolean));
  if (currencies.size > 1) throw new Error('Выписка содержит суммы в разных валютах счёта.');
  const recent = operations.filter(item => !item.day || byDay.has(item.day)).slice(0, 5);
  return {
    timeline, complete, recent,
    currency: currencies.values().next().value ?? 'RUB',
    credit: total('credit'), debit: total('debit'),
  };
}

export async function loadDashboardStatement(request, account, days, signal, now = new Date()) {
  const start = moscowClock(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const query = statementQuery({
    accountNumber: account, from: dateTimeValue(start), categories: '', inns: '', ucid: '', operationStatus: 'Transaction',
  });
  query.to = now.toISOString();
  query.limit = 5000;
  const page = billingRecord(await request(statementPath, { query, signal }), 'operations', 'statement');
  signal.throwIfAborted();
  if (!Array.isArray(page?.operations) || page.operations.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('В ответе прокси нет списка операций выписки.');
  }

  const operationIds = new Set();
  const operations = [];
  for (const item of page.operations) {
    if (String(item.operationStatus ?? 'Transaction').toLowerCase() !== 'transaction') continue;
    const id = typeof item.operationId === 'string' && item.operationId.trim().toLowerCase();
    if (id) {
      if (operationIds.has(id)) throw new Error('В выписке повторяются операции.');
      operationIds.add(id);
    }
    operations.push(statementOperation(item));
  }
  operations.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { ...summarizeFinance(operations, start, days), truncated: Boolean(page.nextCursor) };
}

export async function loadDashboardIncoming(read, signal) {
  const result = await read(0, incomingLimit, signal);
  signal.throwIfAborted();
  const totals = new Map();
  const counts = new Map();
  const ids = new Set();
  let missingAmount = false;
  for (const item of result.rows) {
    const id = typeof item?.operationId === 'string' && item.operationId.trim().toLowerCase();
    if (!id || ids.has(id)) throw new Error('В списке есть пополнения без ID или с повторяющимися ID.');
    ids.add(id);
    const day = dashboardDay(item.transactionDate ?? item.chargeDate ?? item.authorizationDate ?? item.drawDate) ?? '';
    counts.set(day, (counts.get(day) ?? 0) + 1);
    const amount = item.amount ?? item.operationAmount;
    const units = amountUnits(amount);
    const currency = currencyCode(amount?.currency ?? item.currency ?? item.operationCurrency) ?? 'RUB';
    if (units === null) missingAmount = true;
    else totals.set(currency, (totals.get(currency) ?? 0n) + units);
  }
  const page = pageFor(result, 0, incomingLimit);
  return {
    page, totals: missingAmount ? null : totals,
    counts: [...counts].sort(([left], [right]) => right.localeCompare(left)),
    truncated: page.total === undefined ? page.count >= incomingLimit : page.total !== page.count,
  };
}
