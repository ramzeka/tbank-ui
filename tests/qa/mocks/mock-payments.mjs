export function mockPayments(uuid, accountNumber, count) {
  const common = {
    type: 'REGULAR', accountNumber, beneficiaryId: uuid(1), amount: 1500, status: 'SUCCEEDED',
    purpose: 'Оплата комплекта образцов',
  };
  const bankDetails = {
    type: 'PAYMENT_DETAILS', name: 'ООО «Атлас макетов»', bankName: 'Банк макетов',
    accountNumber, corrAccountNumber: '00000000000000000011', bik: '000000001', inn: '0000000001',
  };
  const variants = [
    { bankDetails },
    {
      bankDetails, status: 'FAILED', errorMessage: 'Проверьте счёт получателя.',
      purpose: 'Оплата по тестовой сделке', dealId: uuid(200006), stepId: uuid(300501), recipientId: uuid(400501),
    },
    {
      bankDetails: { type: 'CARD', cardId: '00000000001', terminalKey: 'DEMO-TERMINAL' },
      amount: 3860.25, purpose: 'Оплата поставки',
    },
    {
      bankDetails: { type: 'SBP', phoneNumber: '+70000000001', bankId: '000000000001', terminalKey: 'DEMO-SBP' },
      amount: 980.75, purpose: 'Выплата за выполненные работы',
    },
    {
      type: 'TAX', purpose: 'Демонстрационный налоговый платёж', uin: '0',
      bankDetails: { ...bankDetails, name: 'Демонстрационное казначейство', kpp: '000000001' },
      tax: {
        payerStatus: '19', kbk: '00000000000000000000', oktmo: '00000000', evidence: '0', period: '0',
        docNumber: '0', docDate: '0', thirdParty: { inn: '000000000001', kpp: '0' },
      },
    },
  ];
  const recipientNames = ['ООО «Атлас макетов»', 'ООО «Линия форм»', 'Демонстрационная Лада', 'ООО «Мастерская цвета»'];
  const recipients = recipientNames.map((name, index) => ({
    beneficiaryId: uuid(index + 1),
    bankDetails: { ...bankDetails, name, accountNumber: String(index + 1).padStart(20, '0') },
  }));
  const payments = new Map();
  for (let index = 0; index < count; index++) {
    const paymentId = uuid(500001 + index);
    const fields = variants[index] ?? {
      bankDetails,
      amount: (25000 + index * 175) / 100,
      purpose: 'Демонстрационный платёж ' + (index + 1),
      status: index % 11 === 0 ? 'FAILED' : 'SUCCEEDED',
      ...(index % 11 === 0 ? { errorMessage: 'Платёж отклонён банком получателя.' } : {}),
    };
    const recipient = index % recipients.length;
    const dealId = index >= 64 && recipient === 2
      ? uuid(Math.floor(index / recipients.length) % 2 ? 200003 : 200004)
      : undefined;
    const profile = index >= 64 ? recipients[recipient] : {};
    payments.set(paymentId, { ...common, ...fields, ...profile, ...(dealId ? { dealId } : {}),
      paymentId, operationId: uuid(600001 + index),
    });
  }

  function handle(url, id, { list, reply, error }) {
    if (id) {
      const payment = payments.get(id);
      return payment ? reply(200, payment) : error(404, 'Платёж не найден.');
    }
    const filters = ['accountNumber', 'beneficiaryId', 'dealId']
      .map(field => [field, url.searchParams.get(field)])
      .filter(([, value]) => value);
    const rows = [...payments.values()].filter(payment => filters.every(([field, value]) => payment[field] === value));
    return list(rows, 50);
  };
  return { handle, payments };
}
