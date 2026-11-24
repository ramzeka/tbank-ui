import { randomUUID } from 'node:crypto';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function cents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  const value = Math.round(amount * 100);
  return Number.isSafeInteger(value) && amount === value / 100 ? value : null;
}

export function mockStageParties(uuid, account, { people, accounts, balances, settleBank, held }) {
  const states = new Map();
  const keys = new Map();

  function state(step) {
    if (!states.has(step.stepId)) {
      states.set(step.stepId, { deponents: new Map(), recipients: new Map(), needsRepair: false });
    }
    return states.get(step.stepId);
  }

  function ids(step) {
    return { dealId: step.dealId, stepId: step.stepId };
  }

  function seed(step, fixture) {
    const parties = state(step);
    const failed = step.status === 'PAYMENT_FAILED';
    const beneficiaryId = uuid(failed ? 2 : 1);
    const recipientId = uuid(400000 + fixture * 100 + step.stepNumber);
    parties.deponents.set(beneficiaryId, { ...ids(step), beneficiaryId, amount: 1500 });
    parties.recipients.set(recipientId, {
      ...ids(step), recipientId, beneficiaryId: uuid(failed ? 1 : 3), amount: 1500,
      purpose: 'Оплата по тестовой сделке', keepOnVirtualAccount: !failed,
      ...(failed ? { bankDetailsId: uuid(501) } : {}),
    });
    parties.needsRepair = failed;
  }

  function seedMany(step) {
    const parties = state(step);
    for (let index = 1; index <= 53; index++) {
      const beneficiaryId = uuid(index);
      const recipientId = uuid(410000 + index);
      parties.deponents.set(beneficiaryId, { ...ids(step), beneficiaryId, amount: 1 });
      parties.recipients.set(recipientId, {
        ...ids(step), recipientId, beneficiaryId: uuid(3), amount: 1, keepOnVirtualAccount: true,
      });
    }
  }

  function check(deal, steps, checkBalances) {
    const reasons = [];
    const required = new Map();
    const add = (code, description, details) => reasons.push({ code, description, details });
    for (const step of steps) {
      if (['COMPLETED', 'CANCELLED'].includes(step.status)) continue;
      const { deponents, recipients, needsRepair } = state(step);
      const details = { stepId: step.stepId };
      if (!deponents.size) add('DEMO_NO_DEPONENTS', 'Добавьте депонента.', details);
      if (!recipients.size) add('DEMO_NO_RECIPIENTS', 'Добавьте реципиента.', details);
      const incoming = [...deponents.values()].reduce((total, item) => total + cents(item.amount), 0);
      const outgoing = [...recipients.values()].reduce((total, item) => total + cents(item.amount), 0);
      if (deponents.size && recipients.size && incoming !== outgoing) {
        add('DEMO_AMOUNT_MISMATCH', 'Суммы депонентов и реципиентов не совпадают.', details);
      }
      if (needsRepair) add('DEMO_PAYMENT_REPAIR', 'Обновите реквизиты реципиента после ошибки выплаты.', details);
      for (const item of recipients.values()) {
        if (!item.keepOnVirtualAccount && !accounts.get(item.beneficiaryId)?.has(item.bankDetailsId)) {
          add('DEMO_MISSING_BANK_DETAILS', 'Банковские реквизиты реципиента недоступны.', details);
        }
      }
      for (const item of deponents.values()) {
        required.set(item.beneficiaryId, (required.get(item.beneficiaryId) ?? 0) + cents(item.amount));
      }
    }
    if (checkBalances) for (const [beneficiaryId, requiredAmount] of required) {
      const available = deal.accountNumber === account ? (balances.get(beneficiaryId) ?? 0) - held(beneficiaryId) : 0;
      if (available < requiredAmount) add('DEMO_INSUFFICIENT_FUNDS', 'Недостаточно средств на виртуальном счёте депонента.', {
        beneficiaryId, required: requiredAmount / 100, available: available / 100,
      });
    }
    return reasons;
  }

  function settle(step) {
    const { deponents, recipients } = state(step);
    for (const item of deponents.values()) balances.set(item.beneficiaryId, balances.get(item.beneficiaryId) - cents(item.amount));
    for (const item of recipients.values()) {
      if (item.keepOnVirtualAccount) {
        balances.set(item.beneficiaryId, (balances.get(item.beneficiaryId) ?? 0) + cents(item.amount));
      } else {
        settleBank(item);
      }
    }
  }

  function handle(req, deal, step, route, [id, action, ...rest], { reply, error, list }) {
    const method = req.method;
    const parties = state(step);
    const items = parties[route];
    const draft = deal.status === 'DRAFT';
    const recipient = route === 'recipients';
    if (rest.length || (action && (!recipient || action !== 'update-bank-details' || method !== 'POST'))) {
      return error(404, 'Маршрут участника не найден.');
    }
    if (method === 'GET') {
      if (!id) return list([...items.values()], 50);
      return items.has(id) ? reply(200, items.get(id)) : error(404, 'Участник этапа не найден.');
    }
    if (method === 'DELETE') {
      if (!draft) return error(422, 'Удалять участников можно только в черновике.');
      if (!items.delete(id)) return error(404, 'Участник этапа не найден.');
      return reply(200);
    }
    if (!draft && !action) return error(422, 'Менять участников можно только в черновике.');

    const raw = req.mockBody;
    const body = JSON.parse(raw);
    if (action) {
      if (step.status !== 'PAYMENT_FAILED') return error(422, 'Замена реквизитов доступна после ошибки выплаты.');
      const item = items.get(id);
      if (!item) return error(404, 'Реципиент этапа не найден.');
      if (!accounts.get(item.beneficiaryId)?.has(body?.bankDetailsId)) {
        return error(422, 'У бенефициара нет указанных реквизитов.');
      }
      item.bankDetailsId = body.bankDetailsId;
      item.keepOnVirtualAccount = false;
      parties.needsRepair = false;
      return reply(200);
    }

    const beneficiaryId = recipient ? body?.beneficiaryId : id;
    if (!people.has(beneficiaryId)) return error(422, 'Бенефициар не найден.');
    if (cents(body?.amount) === null) return error(400, 'Укажите положительную сумму с точностью до копеек.');
    if (!recipient && method === 'PUT') {
      const item = { ...ids(step), beneficiaryId, amount: body.amount };
      items.set(beneficiaryId, item);
      return reply(200, item);
    }
    if (!recipient || !['PUT', 'POST'].includes(method)) return error(405, 'Метод участника недоступен.');
    if (method === 'PUT' && !items.has(id)) return error(404, 'Реципиент этапа не найден.');
    if (body.purpose != null && (typeof body.purpose !== 'string' || !body.purpose.trim() || body.purpose.length > 210)) {
      return error(400, 'Проверьте назначение платежа.');
    }
    const bank = body.bankDetailsId;
    if (bank && !accounts.get(beneficiaryId)?.has(bank)) return error(422, 'У бенефициара нет указанных реквизитов.');
    let cacheKey;
    if (method === 'POST') {
      const key = req.headers['idempotency-key'];
      if (!uuidPattern.test(key)) return error(400, 'Требуется Idempotency-Key.');
      cacheKey = step.stepId + '/' + key;
      const previous = keys.get(cacheKey);
      if (previous) return previous.raw === raw ? reply(201, previous.item) : error(409, 'Ключ уже использован.');
    }
    const item = {
      ...ids(step), beneficiaryId, recipientId: id || randomUUID(), amount: body.amount,
      keepOnVirtualAccount: body.keepOnVirtualAccount === true || !bank,
      ...(body.purpose ? { purpose: body.purpose } : {}),
      ...(bank ? { bankDetailsId: bank } : {}),
    };
    items.set(item.recipientId, item);
    if (cacheKey) keys.set(cacheKey, { raw, item: { ...item } });
    return reply(method === 'POST' ? 201 : 200, item);
  }

  return { seed, seedMany, check, settle, handle, remove: step => states.delete(step.stepId) };
}
