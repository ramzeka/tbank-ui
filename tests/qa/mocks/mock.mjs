
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { mockStatement } from './mock-statement.mjs';
import { mockBilling } from './mock-billing.mjs';
import { mockPayments } from './mock-payments.mjs';
import { mockDeals } from './mock-deals.mjs';

export const testToken = 'demo-local-only';
export const secondToken = 'demo-second-operator';
export const demoAccount = '00000000000000000001';
export const uuid = n => 'de000000-2026-4011-8000-' + String(n).padStart(12, '0');

const base = '/api/v1/nominal-accounts/';
const beneficiaryNames = ['Атлас макетов', 'Линия форм', 'Точка эскиза', 'Мастерская цвета'];

function beneficiary(index) {
  const name = 'ООО «' + (beneficiaryNames[index] ?? 'Демо-проект ' + (index + 1)) + '»';
  if (index === 2) return {
    type: 'FL_RESIDENT', firstName: 'Лада', lastName: 'Демонстрационная', isSelfEmployed: false,
    birthDate: '1990-03-12', citizenship: 'RU',
    documents: [{ type: 'PASSPORT', serial: '0000', number: '000001', date: '2020-02-02', division: '000-000' }],
    addresses: [{ type: 'REGISTRATION_ADDRESS', address: 'Демо-город, улица Макетов, 1' }],
  };
  if (index === 7) return {
    type: 'FL_RESIDENT', firstName: 'Борис', lastName: 'Демонстрационный', isSelfEmployed: false,
  };
  return { type: 'UL_RESIDENT', name, inn: String(index + 1).padStart(10, '0'), opf: 'ООО', registrationDate: '2024-05-16' };
}

function bankRecord(index) {
  return {
    bankDetailsId: uuid(501 + index), type: 'PAYMENT_DETAILS',
    bankName: index ? 'Банк образцов' : 'Банк макетов', bik: '00000000' + (index + 1),
    accountNumber: String(index + 1).padStart(20, '0'),
    corrAccountNumber: String(index + 11).padStart(20, '0'),
    kpp: '000000001', isDefault: index === 0,
  };
}

function deposit(index) {
  const date = new Date(Date.now() - (Math.min(index, 4) + 2) * 86400000).toISOString().slice(0, 10);
  const amount = [18450, 12800, 46200][index] ?? 1000 + index;
  const id = index < 3 ? 801 + index : 100000 + index;
  return {
    operationId: uuid(id), amount, currency: 'RUB', transactionDate: date, accountNumber: demoAccount,
    payerName: 'ООО «' + (beneficiaryNames[index] ?? 'Демо-плательщик ' + (index + 1)) + '»',
    paymentPurpose: 'Демонстрационное пополнение ' + (index + 1),
    documentNumber: String(1000 + index),
  };
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startMock({ large = false, trace, faults = [] } = {}) {
  const people = new Map();
  const accounts = new Map();
  const keys = new Map();
  const peopleCount = large ? 50000 : 180;
  const depositCount = large ? 20000 : 120;
  const paymentCount = large ? 20000 : 360;
  for (let index = 0; index < peopleCount; index++) {
    const id = uuid(index + 1);
    people.set(id, { ...beneficiary(index), email: 'demo' + (index + 1) + '@example.org', beneficiaryId: id });
    accounts.set(id, new Map());
  }
  for (const bank of [bankRecord(0), bankRecord(1)]) accounts.get(uuid(1)).set(bank.bankDetailsId, bank);
  const deposits = Array.from({ length: depositCount }, (_, index) => deposit(index));
  const balances = new Map([[uuid(1), 2845075], [uuid(2), 725000], [uuid(3), 0]]);
  const handleStatement = mockStatement(uuid, demoAccount);
  const { handle: handlePayments, payments } = mockPayments(uuid, demoAccount, paymentCount);
  const billing = mockBilling(uuid, demoAccount, { people, accounts, balances, payments });
  const handleDeals = mockDeals(uuid, demoAccount, { people, accounts, balances, settleBank: billing.settleBank, held: billing.held });
  const scoring = new Map([
    [uuid(1), { status: 'SUCCEEDED' }], [uuid(2), { status: 'FAILED', errors: ['UL_CLOSED'] }],
    [uuid(3), { status: 'SUCCEEDED', warnings: ['IN_BLACKLIST'] }], [uuid(5), { status: 'IN_PROGRESS' }],
    [uuid(6), { status: 'DEMO_NEW_STATUS', warnings: ['DEMO_NEW_CODE'] }],
    [uuid(8), { status: 'FAILED', errors: ['INVALID_INN', 'INVALID_PASSPORT'], warnings: ['IN_BLACKLIST'] }],
    [uuid(9), { status: 'FAILED', errors: ['UL_NOT_FOUND'] }],
  ]);

  let origin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const { method } = req;
    const faultIndex = faults.findIndex(fault => fault.method === method && fault.path === url.pathname &&
      (!fault.query || Object.entries(fault.query).every(([key, value]) => url.searchParams.get(key) === value)));
    const fault = faultIndex === -1 ? undefined : faults.splice(faultIndex, 1)[0];
    const entry = { method, path: url.pathname, url: req.url, key: req.headers['idempotency-key'], account: req.headers.bankaccountid };

    function reply(status, body) {
      const { phase, status: delivery } = fault ?? {};
      const lost = phase === 'after' && status >= 200 && status < 300;
      const event = { ...entry, status, ...(lost && { delivery }), response: body };
      trace?.push(structuredClone(event));
      if (lost) return writeJson(res, delivery, fault.body ?? { message: 'QA: ответ после записи недоступен.' });
      if (fault?.http) return writeJson(res, fault.http, body);
      const responseBody = fault?.encode ? JSON.stringify(body) : body;
      return writeJson(res, 200, { responseCode: status, responseBody });
    }

    const error = (status, errorMessage, errorDetails) => reply(status, { errorMessage, errorDetails });
    const list = (rows, max = 100) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > max || !Number.isInteger(offset) || offset < 0) {
        return error(400, 'Проверьте параметры страницы.');
      }
      return reply(200, { results: rows.slice(offset, offset + limit), total: rows.length, offset, limit });
    };

    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      req.mockBody = Buffer.concat(chunks).toString('utf8');
      if (req.mockBody) entry.body = JSON.parse(req.mockBody);
      if (fault?.delay) await setTimeout(fault.delay);
      if (fault?.phase === 'before') return reply(fault.status, fault.body);

      if (![testToken, secondToken].some(token => req.headers.authorization === 'Bearer ' + token)) {
        return error(401, 'Нужен демонстрационный токен');
      }
      const path = url.pathname.replace(/^\/qa-gateway(?=\/api\/)/, '');
      if (path === '/api/v2/nominal-accounts/beneficiaries/scoring' && method === 'GET') {
        const id = url.searchParams.get('beneficiaryId');
        if (!people.has(id)) return error(404, 'Бенефициар не найден');
        if (id === uuid(7)) return error(503, 'Сервис скоринга временно недоступен.');
        return list(scoring.has(id) ? [{ beneficiaryId: id, ...scoring.get(id) }] : [], 50);
      }
      if (path === '/api/v1/statement' && method === 'GET') return handleStatement(url, reply, error);
      if (!path.startsWith(base)) return error(404, 'Маршрут не найден');
      const [route, id, sub, target, action, ...rest] = path.slice(base.length).split('/');
      const handlers = { list, reply, error };
      if (route === 'deals') return handleDeals(req, { id, sub, bid: target, action, rest, ...handlers });
      if (route === 'payments' && !target && !action && !rest.length) {
        if (method === 'GET' && !sub) return handlePayments(url, id, handlers);
        if (method === 'POST' && !id) return billing.create(req, 'payment', handlers);
        if (method === 'POST' && id && sub === 'retry') return billing.retry(id, handlers);
      }
      if (route === 'virtual-accounts' && !target && !action && !rest.length) {
        if (id === 'transfers' && method === 'GET') return billing.readTransfer(url, sub, handlers);
        if (id === 'transfers' && method === 'POST' && !sub) return billing.create(req, 'transfer', handlers);
        if (id === 'holds' && method === 'GET' && !sub) return billing.readHolds(url, handlers);
        if (id === 'balances' && method === 'GET' && !sub) {
          const beneficiaryId = url.searchParams.get('beneficiaryId');
          const number = url.searchParams.get('accountNumber');
          if (!balances.has(beneficiaryId) || (number && number !== demoAccount)) return list([], 50);
          const balance = balances.get(beneficiaryId);
          const held = billing.held(beneficiaryId);
          return list([{
            beneficiaryId, accountNumber: demoAccount, balance: balance / 100,
            availableBalance: (balance - held) / 100, heldAmount: held / 100, currency: 'RUB',
          }], 50);
        }
      }
      if (route === 'incoming-transactions') {
        if (!id && method === 'GET') {
          const number = url.searchParams.get('accountNumber');
          return list(deposits.filter(item => !number || item.accountNumber === number), 50);
        }
        if (id && sub === 'identify' && !target && method === 'POST') {
          const index = deposits.findIndex(item => item.operationId === id);
          if (index < 0) return error(404, 'Пополнение не найдено');
          const { amountDistribution } = entry.body;
          if (!Array.isArray(amountDistribution) || !amountDistribution.length) return error(400, 'Добавьте распределение');
          const credits = new Map();
          for (const { beneficiaryId, amount } of amountDistribution) {
            if (!people.has(beneficiaryId) || credits.has(beneficiaryId)) return error(422, 'Проверьте ID бенефициара');
            const cents = Math.round(amount * 100);
            if (typeof amount !== 'number' || cents <= 0 || !Number.isSafeInteger(cents) || cents / 100 !== amount) {
              return error(422, 'Проверьте сумму');
            }
            credits.set(beneficiaryId, cents);
          }
          const total = [...credits.values()].reduce((sum, cents) => sum + cents, 0);
          if (total !== Math.round(deposits[index].amount * 100)) return error(422, 'Суммы не совпадают');
          for (const [beneficiaryId, cents] of credits) balances.set(beneficiaryId, (balances.get(beneficiaryId) ?? 0) + cents);
          deposits.splice(index, 1);
          return reply(200);
        }
      }

      if (route !== 'beneficiaries' || rest.length) return error(404, 'Маршрут не найден');
      if (!id && method === 'GET') return list([...people.values()]);
      if (id && !people.has(id)) return error(404, 'Бенефициар не найден');
      if (sub && sub !== 'bank-details') return error(404, 'Маршрут не найден');
      const banks = accounts.get(id);
      if (target && !banks?.has(target)) return error(404, 'Реквизиты не найдены');
      if (method === 'GET' && !action) {
        if (!sub) return reply(200, people.get(id));
        return target ? reply(200, banks.get(target)) : list([...banks.values()], 50);
      }
      if (method === 'POST' && action === 'set-default') {
        for (const bank of banks.values()) bank.isDefault = bank.bankDetailsId === target;
        return reply(200);
      }
      if (method === 'DELETE' && target && !action) {
        const wasDefault = banks.get(target).isDefault;
        banks.delete(target);
        if (wasDefault && banks.size) banks.values().next().value.isDefault = true;
        return reply(200);
      }

      const creating = method === 'POST' && (!id || (sub && !target));
      const updating = method === 'PUT' && id && (!sub || target);
      if (action || (!creating && !updating)) return error(405, 'Метод недоступен');
      const cacheKey = path + '|' + entry.key;
      if (creating && !entry.key) return error(400, 'Требуется Idempotency-Key');
      if (creating && keys.has(cacheKey)) {
        const previous = keys.get(cacheKey);
        return previous.raw === req.mockBody ? reply(201, previous.record) : error(409, 'Ключ уже использован');
      }
      let record;
      if (sub) {
        const body = entry.body;
        if (body.type !== 'PAYMENT_DETAILS' || !body.bankName) {
          return error(400, 'Проверьте реквизиты', { bankName: ['Укажите название банка'] });
        }
        const bankDetailsId = target ?? randomUUID();
        const isDefault = body.isDefault ?? banks.get(bankDetailsId)?.isDefault ?? !banks.size;
        if (isDefault) for (const bank of banks.values()) bank.isDefault = false;
        record = { ...body, bankDetailsId, isDefault };
        banks.set(bankDetailsId, record);
      } else {
        const beneficiaryId = id ?? randomUUID();
        record = { ...entry.body, beneficiaryId };
        people.set(beneficiaryId, record);
        if (creating) accounts.set(beneficiaryId, new Map());
      }
      if (creating) keys.set(cacheKey, { raw: req.mockBody, record: structuredClone(record) });
      return reply(creating ? 201 : 200, record);
    } catch (failure) {
      if (!res.headersSent) return error(failure instanceof SyntaxError ? 400 : 500, failure.message);
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, server, people, accounts, balances, deposits, payments, peopleCount, depositCount, paymentCount };
}
