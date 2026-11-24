export function mockStatement(uuid, accountNumber) {
  const now = Date.now();
  const card = '9000000000000000001';
  const categories = ['DEMO_TRANSFER', 'DEMO_CARD', 'DEMO_FEE'];
  const operations = Array.from({ length: 680 }, (_, index) => {
    const credit = index % 2 === 0;
    const authorization = index % 5 === 0;
    const category = categories[index % categories.length];
    const counterparty = {
      name: index % 2 === 0 ? 'ООО «Атлас макетов»' : 'ООО «Линия форм»',
      inn: index % 2 === 0 ? '0000000001' : '0000000002',
    };
    return {
      operationId: uuid(920001 + index),
      operationDate: new Date(now - (index + 1) * 3 * 60 * 60 * 1000).toISOString(),
      typeOfOperation: credit ? 'Credit' : 'Debit',
      operationStatus: authorization ? 'Authorization' : 'Transaction',
      category, accountAmount: { value: 100 + index * 2.5, currency: '643' },
      ...(authorization ? { counterParty: counterparty } : credit ? { payer: counterparty } : { receiver: counterparty }),
      payPurpose: 'Демонстрационная операция ' + (index + 1),
      ...(category === 'DEMO_CARD' ? { ucid: card } : {}),
    };
  });

  return function handle({ searchParams: params }, reply, error) {
    const number = params.get('accountNumber');
    const limit = Number(params.get('limit') ?? 1000);
    const from = Date.parse(params.get('from'));
    const to = params.has('to') ? Date.parse(params.get('to')) : now;
    if (number !== accountNumber || !Number.isInteger(limit) || limit < 1 || limit > 5000 ||
      !Number.isFinite(from) || !Number.isFinite(to) || from >= to || params.has('offset')) {
      return error(400, 'Проверьте номер тестового счёта, период и размер страницы.');
    }
    const categories = params.getAll('categories');
    const inns = params.getAll('inns');
    const ucid = params.get('ucid');
    const status = params.get('operationStatus');
    const cursor = params.get('cursor');
    const rows = operations.filter(item => {
      const date = Date.parse(item.operationDate);
      const party = item.counterParty ?? item.payer ?? item.receiver;
      return date >= from && date < to && (!categories.length || categories.includes(item.category)) &&
        (!inns.length || inns.includes(party.inn)) && (!ucid || ucid === item.ucid) &&
        (!status || status === 'All' || status === item.operationStatus);
    });
    const previous = cursor ? rows.findIndex(item => 'statement:' + item.operationId === cursor) : -1;
    if (cursor && previous === -1) return error(400, 'Курсор тестовой выписки не найден.');
    const page = rows.slice(previous + 1, previous + 1 + limit);
    const response = { operations: page };
    if (previous + 1 + page.length < rows.length) response.nextCursor = 'statement:' + page.at(-1).operationId;
    if (!cursor && params.get('withBalances') === 'true') {
      const subtotal = direction => rows.filter(item => item.typeOfOperation === direction && item.operationStatus === 'Transaction')
        .reduce((sum, item) => sum + item.accountAmount.value, 0);
      const credit = subtotal('Credit');
      const debit = subtotal('Debit');
      const date = rows[0]?.operationDate.slice(0, 10);
      response.balances = {
        credit, debit, openingBalance: 70000, closingBalance: 70000 + credit - debit,
        ...(date ? { balances: [{ date, credit, debit }] } : {}),
      };
    }
    return reply(200, response);
  };
}
