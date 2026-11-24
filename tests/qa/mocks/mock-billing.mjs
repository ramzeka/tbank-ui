import { randomUUID } from 'node:crypto';

export function mockBilling(uuid, accountNumber, { people, accounts, balances, payments }) {
  const transfers = new Map();
  const idempotency = new Map();
  const retries = new Set();
  const holds = [
    { beneficiaryId: uuid(1), accountNumber, holdId: uuid(800001), amount: 350, dealId: uuid(200002), stepId: uuid(300101) },
    { beneficiaryId: uuid(1), accountNumber, holdId: uuid(800002), amount: 125, dealId: uuid(200003), stepId: uuid(300202) },
    { beneficiaryId: uuid(2), accountNumber, holdId: uuid(800003), amount: 1500, dealId: uuid(200006), stepId: uuid(300501) },
  ];
  const held = id => holds.filter(hold => hold.beneficiaryId === id).reduce((sum, hold) => sum + Math.round(hold.amount * 100), 0);
  for (let index = 0; index < 145; index++) {
    const transferId = uuid(700001 + index);
    const from = { beneficiaryId: uuid(index % 2 + 1) };
    const to = { beneficiaryId: uuid(3) };
    transfers.set(transferId, {
      transferId, type: 'DIRECT', accountNumber, from, to, amount: (10000 + index * 125) / 100,
      purpose: 'Демонстрационный перевод ' + (index + 1),
    });
  }

  for (let index = 0; index < 96; index++) {
    const transferId = uuid(700146 + index);
    const beneficiaryId = uuid(index % 2 === 0 ? 3 : 4);
    const dealId = index % 8 === 0 ? uuid(200002) : undefined;
    transfers.set(transferId, {
      transferId, type: dealId ? 'DEAL' : 'DIRECT', accountNumber,
      from: dealId ? { beneficiaryIds: index === 0 ? [beneficiaryId, uuid(4)] : [beneficiaryId] } : { beneficiaryId },
      to: { beneficiaryId: uuid(1) }, amount: 250 + index,
      purpose: 'Входящий тестовый перевод ' + (index + 1),
      ...(dealId ? { dealId, stepId: uuid(300101) } : {}),
    });
  }

  function create(req, kind, { error, reply }) {
    const key = kind + '/' + (req.headers['idempotency-key'] ?? '');
    const raw = req.mockBody;
    if (!req.headers['idempotency-key']) return error(400, 'Требуется ключ идемпотентности.');
    const cached = idempotency.get(key);
    if (cached) return raw === cached.raw ? reply(201, cached.item) : error(409, 'Ключ уже использован.');
    const body = JSON.parse(raw);
    const { amount, purpose } = body;
    const sender = kind === 'payment' ? body.beneficiaryId : body.from?.beneficiaryId;
    const recipient = body.to?.beneficiaryId;
    if (body.accountNumber !== accountNumber || !people.has(sender) || !Number.isFinite(amount) ||
        amount <= 0 || Number(amount.toFixed(2)) !== amount) {
      return error(422, 'Проверьте номинальный счёт, отправителя и сумму.');
    }
    const cents = Math.round(amount * 100);
    if ((balances.get(sender) ?? 0) - held(sender) < cents) return error(422, 'Недостаточно доступных средств.');
    if (purpose && (typeof purpose !== 'string' || purpose.length > 210)) return error(422, 'Проверьте назначение.');
    let item;
    if (kind === 'payment') {
      const details = accounts.get(sender)?.get(body.bankDetailsId);
      if (!details || body.type !== 'REGULAR' || !purpose) return error(422, 'Проверьте реквизиты и назначение.');
      const paymentId = randomUUID();
      item = {
        paymentId, type: 'REGULAR', accountNumber, beneficiaryId: sender, amount, purpose,
        bankDetails: { name: people.get(sender).name, ...details }, operationId: randomUUID(), status: 'SUCCEEDED',
      };
      payments.set(paymentId, item);
    } else {
      if (!people.has(recipient) || recipient === sender) return error(422, 'Выберите другого бенефициара-получателя.');
      const transferId = randomUUID();
      item = { transferId, type: 'DIRECT', accountNumber, from: body.from, to: body.to, amount, ...(purpose ? { purpose } : {}) };
      transfers.set(transferId, item);
      balances.set(recipient, (balances.get(recipient) ?? 0) + cents);
    }
    balances.set(sender, balances.get(sender) - cents);
    idempotency.set(key, { raw, item });
    return reply(201, item);
  }

  function retry(id, { reply, error }) {
    const original = payments.get(id);
    if (!original) return error(404, 'Платёж не найден.');
    if (!original.dealId || original.status !== 'FAILED') return error(422, 'Можно повторить неуспешный платёж по сделке.');
    if (retries.has(id)) return error(409, 'Повтор уже запущен.');
    const { errorMessage, operationId, ...snapshot } = original;
    const retryPaymentId = randomUUID();
    payments.set(retryPaymentId, { ...snapshot, paymentId: retryPaymentId, status: 'IN_PROGRESS' });
    retries.add(id);
    return reply(200, { retryPaymentId });
  }

  function settleBank(recipient) {
    const { dealId, stepId, recipientId, beneficiaryId, amount, purpose, bankDetailsId } = recipient;
    const paymentId = randomUUID();
    payments.set(paymentId, {
      paymentId, dealId, stepId, recipientId, beneficiaryId, amount, purpose, accountNumber,
      type: 'REGULAR', status: 'IN_PROGRESS',
      bankDetails: { name: people.get(beneficiaryId).name, ...accounts.get(beneficiaryId).get(bankDetailsId) },
    });
  }

  function readTransfer(url, id, { list, reply, error }) {
    if (id) {
      const item = transfers.get(id);
      return item ? reply(200, item) : error(404, 'Перевод не найден.');
    }
    if (url.searchParams.get('accountNumber') !== accountNumber) return error(422, 'Укажите тестовый номинальный счёт.');
    const dealId = url.searchParams.get('dealId');
    const fromId = url.searchParams.get('fromBeneficiaryId');
    const toId = url.searchParams.get('toBeneficiaryId');
    const matches = (party, id) => !id || party.beneficiaryId === id || party.beneficiaryIds?.includes(id);
    return list([...transfers.values()].filter(item =>
      (!dealId || item.dealId === dealId) && matches(item.from, fromId) && matches(item.to, toId)), 50);
  }

  function readHolds(url, { list }) {
    const id = url.searchParams.get('beneficiaryId');
    const number = url.searchParams.get('accountNumber');
    return list(holds.filter(hold => (!id || hold.beneficiaryId === id) && (!number || hold.accountNumber === number)), 50);
  }

  return { create, retry, readTransfer, readHolds, held, settleBank };
}
