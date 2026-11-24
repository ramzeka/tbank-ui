
import { assert, path, test, until, uuid, demoAccount } from './harness.mjs';
import { u1, u2, u3, u4, row, list, open, payment, transfer, identify, reload, sameKey, last, count, sign } from './flows.mjs';

const { incoming: INC, payments: PAY, transfers: TR } = path;
const identifyPath = id => INC + '/' + id + '/identify';
const submit = '#billing-submit';

async function filters(t, values) {
  await t.click('#billing-filter-button');
  for (const [id, value] of Object.entries(values)) await t.fill('#filter-' + id, value);
  await t.click('#billing-filters-form button[type=submit]');
  await t.gone('#billing-filters-dialog');
}

async function resetFilters(t) {
  await t.click('#billing-filter-button');
  await t.click('#billing-filters-reset');
}

export const billing = [
  test('INC-01', 'Поиск вне первой страницы, отмена поиска и распределение до копейки', async t => {
    await list(t, 'incoming-transactions');
    await open(t, 'incoming-transactions', uuid(100055));
    await t.has('#transaction-data', 'Демо-плательщик');
    await t.click('#transaction-back');
    await t.fill('#transaction-search-id', uuid(999999));
    await t.click('#transaction-search-open');
    await t.click('#transaction-search-cancel');
    await t.gone('#transaction-search-cancel');
    const id = uuid(801);
    const route = identifyPath(id);
    await identify(t, id, u3);
    await t.click('.distribution-row:first-child .recipient-check');
    await t.has('.distribution-row:first-child .recipient-info', 'Лада');
    await t.fill(row(1, 'amount'), '1000,01');
    await t.click('#distribution-add');
    await t.fill(row(2, 'beneficiaryId'), u3);
    await t.click('#identify-submit');
    assert.match(await t.evaluate(() => document.querySelector('#distribution-rows .distribution-row:nth-child(2) input').validationMessage), /уже есть/);
    await t.fill(row(2, 'beneficiaryId'), u2);
    await t.fill(row(2, 'amount'), '17449,98');
    await t.click('#identify-submit');
    await t.has('#identify-status', 'должна совпадать');
    assert.equal(t.calls('POST', route).length, 0);
    await t.fill(row(2, 'amount'), '17449,99');
    const previous = [t.mock.balances.get(u3), t.mock.balances.get(u2)];
    t.before('POST', route, 422, { errorMessage: 'QA: ошибка до зачисления' });
    await t.click('#identify-submit');
    await t.has('#identify-status', '422');
    assert.equal(await t.evaluate(selector => document.querySelector(selector).value, row(2, 'amount')), '17449,99');
    await t.click('#identify-submit');
    await t.gone('#identify-dialog');
    await t.gone('#result tr[data-operation-id="' + id + '"]');
    assert.deepEqual([t.mock.balances.get(u3), t.mock.balances.get(u2)], [previous[0] + 100001, previous[1] + 1744999]);
    assert(!t.mock.deposits.some(item => item.operationId === id));
  }),
  test('INC-02', 'Потеря ответа после зачисления, сверка по ID и обновление списка без второго POST', async t => {
    const id = uuid(802);
    const route = identifyPath(id);
    const balance = t.mock.balances.get(u3);
    await identify(t, id, u3);
    t.after('POST', route);
    await t.click('#identify-submit');
    await t.has('#identify-status', 'Перед повтором проверьте');
    assert(await t.evaluate(() => document.querySelector('#identify-submit').disabled));
    await t.click('#identify-cancel');
    await t.clickText('#transaction-actions', 'Идентифицировать');
    await t.wait('#identify-verify');
    await t.click('#identify-verify');
    await t.has('#identify-status', 'Пополнение отсутствует в списке', 85000);
    assert(await t.evaluate(() => document.querySelector('#identify-submit').disabled));
    await t.has('#identify-cancel', 'К списку');
    await t.click('#identify-cancel');
    await t.has('#identify-feedback', 'Сверьте распределение');
    await t.gone('#result tr[data-operation-id="' + id + '"]');
    assert.equal(t.calls('POST', route).length, 1);
    assert.equal(t.mock.balances.get(u3), balance + 1280000);
  }),
  test('INC-03', 'Сбой до регистрации, недоступная сверка и затем разрешенный повтор', async t => {
    const id = uuid(100056);
    const route = identifyPath(id);
    await identify(t, id, u2);
    const original = t.mock.deposits.find(item => item.operationId === id);
    const balance = t.mock.balances.get(u2);
    t.before('POST', route, 503, { errorMessage: 'QA: временный сбой' });
    await t.click('#identify-submit');
    await t.has('#identify-status', 'Перед повтором проверьте');
    t.before('GET', INC, 503, { errorMessage: 'QA: список недоступен' });
    await t.click('#identify-verify');
    await t.has('#identify-status', 'Проверка пополнения не удалась');
    assert(await t.evaluate(() => document.querySelector('#identify-submit').disabled));
    await t.click('#identify-verify');
    await t.has('#identify-status', 'Пополнение всё ещё в списке');
    await t.click('#identify-submit');
    await t.gone('#identify-dialog');
    assert.equal(t.mock.balances.get(u2), balance + original.amount * 100);
    assert.deepEqual(t.calls('POST', route).map(call => call.status), [503, 200]);
  }),
  test('INC-04', 'Сверка отклоняет повторяющийся ID и блокирует старое распределение после изменения суммы', async t => {
    const id = uuid(100058);
    const route = identifyPath(id);
    const original = t.mock.deposits.find(item => item.operationId === id);
    await identify(t, id, u2);
    t.before('POST', route, 408, { errorMessage: 'QA: тайм-аут до регистрации' });
    await t.click('#identify-submit');
    await t.has('#identify-status', 'Перед повтором проверьте');
    const repeated = t.mock.deposits[0];
    t.before('GET', INC, 200, { results: [repeated, repeated], total: t.mock.deposits.length });
    await t.click('#identify-verify');
    await t.has('#identify-status', 'повторяющимися ID');
    original.amount++;
    try {
      await t.click('#identify-verify');
      await t.has('#identify-status', 'Данные пополнения изменились');
      assert(await t.evaluate(() => document.querySelector('#identify-submit').disabled));
      await t.click('#identify-cancel');
      await t.has('#identify-feedback', 'Откройте его заново');
      assert.deepEqual(t.calls('POST', route).map(call => call.status), [408]);
    } finally {
      original.amount--;
    }
  }),
  test('PAY-01', 'Последняя страница, два фильтра и повтор выплаты с переходом в карточку', async t => {
    await list(t, 'payments');
    await t.click('#pagination [data-page=last]');
    const offset = Math.floor((t.mock.paymentCount - 1) / 50) * 50;
    await until(() => t.calls('GET', PAY).some(call => call.url.includes('offset=' + offset)), 'последняя страница');
    await t.click('#billing-filter-button');
    await t.fill('#filter-beneficiary', 'bad-id');
    await t.click('#billing-filters-form button[type=submit]');
    assert.equal(await t.evaluate(() => document.querySelector('#filter-beneficiary').validity.valid), false);
    await t.fill('#filter-beneficiary', u1);
    await t.fill('#filter-deal', uuid(200006));
    await t.click('#billing-filters-form button[type=submit]');
    const id = uuid(500002);
    await t.has('#result', id);
    assert.equal(await count(t), 1);
    await open(t, 'payments', id);
    await t.has('#payment-error', 'Причина ошибки');
    const route = PAY + '/' + id + '/retry';
    t.cancelConfirm();
    await t.click('#payment-retry');
    assert.equal(t.calls('POST', route).length, 0);
    await t.click('#payment-retry');
    const request = await until(() => last(t, 'POST', route), 'ответ на повтор выплаты');
    const retryId = request.response.retryPaymentId;
    await t.clickText('#payment-retry-result', retryId);
    await t.has('#payment-data', retryId);
    await list(t, 'payments');
    await resetFilters(t);
  }),
  test('PAY-02', 'Прямой платеж, 502, двойной клик и независимая операция после успеха', async t => {
    await list(t, 'payments');
    const balance = t.mock.balances.get(u1);
    const offset = t.calls('POST', PAY).length;
    await payment(t);
    t.after('POST', PAY);
    await t.click(submit);
    await t.has('#billing-status', '502');
    await t.evaluate(() => {
      const button = document.querySelector('#billing-submit');
      button.click();
      button.click();
    });
    await t.gone('#billing-dialog');
    const [first, retry] = t.calls('POST', PAY).slice(offset);
    assert.equal(t.calls('POST', PAY).length, offset + 2);
    sameKey(first, retry);
    assert.equal(first.response.paymentId, retry.response.paymentId);
    assert.equal(t.mock.balances.get(u1), balance - 1705);
    await t.has('#payment-data', first.response.paymentId);
    await list(t, 'payments');
    await payment(t);
    await t.click(submit);
    await t.wait('#payment-panel');
    const fresh = last(t, 'POST', PAY);
    assert.notEqual(fresh.key, first.key);
    assert.notEqual(fresh.response.paymentId, first.response.paymentId);
    assert.equal(t.mock.balances.get(u1), balance - 3410);
  }),
  test('PAY-03', 'Ретрай прямого платежа после перезагрузки сохраняет ключ, ID и одно списание', async t => {
    await list(t, 'payments');
    const balance = t.mock.balances.get(u1);
    const purpose = 'QA Платёж после перезагрузки';
    await payment(t, '13,07', purpose);
    t.after('POST', PAY);
    await t.click(submit);
    await t.has('#billing-status', '502');
    const first = last(t, 'POST', PAY);
    await reload(t);
    await list(t, 'payments');
    await payment(t, '13,07', purpose);
    await t.click(submit);
    await t.has('#payment-data', first.response.paymentId);
    sameKey(first, last(t, 'POST', PAY));
    assert.equal(t.mock.balances.get(u1), balance - 1307);
  }),
  test('PAY-04', 'При неопределенном итоге повтора выплаты карточка предлагает сверить сделку', async t => {
    const id = uuid(599001);
    const original = t.mock.payments.get(uuid(500002));
    t.mock.payments.set(id, { ...original, paymentId: id });
    await list(t, 'payments');
    await open(t, 'payments', id);
    const old = t.mock.payments.size, route = PAY + '/' + id + '/retry';
    t.after('POST', route);
    await t.click('#payment-retry');
    await t.has('#payment-feedback', 'Проверьте список платежей по сделке');
    await t.gone('#payment-retry');
    const retryId = last(t, 'POST', route).response.retryPaymentId;
    await list(t, 'payments');
    await filters(t, { deal: original.dealId });
    await t.has('#result', retryId);
    assert.equal((await t.relay(route, { method: 'POST' })).status, 409);
    assert.equal(t.mock.payments.size, old + 1);
    await resetFilters(t);
  }),
  test('PAY-05', 'В карточке показываются реквизиты счета, карты, СБП и налогового платежа', async t => {
    for (const [index, expected] of [[1, demoAccount], [3, '00000000001'], [4, '+70000000001'], [5, '00000000000000000000']]) {
      await list(t, 'payments');
      await open(t, 'payments', uuid(500000 + index));
      await t.has('#payment-data', expected);
      await t.gone('#payment-retry');
    }
  }),
  test('PAY-06', 'HTTP 502 с успешным кодом в теле сохраняет ключ для новой вкладки', async t => {
    await list(t, 'payments');
    const balance = t.mock.balances.get(u1);
    const purpose = 'QA Платёж из новой вкладки';
    const offset = t.calls('POST', PAY).length;
    await payment(t, '11,43', purpose);
    t.after('POST', PAY, { body: { responseCode: 201, responseBody: {} } });
    await t.click(submit);
    await t.has('#billing-status', 'HTTP 502');
    const first = last(t, 'POST', PAY);
    await t.click('#billing-cancel');
    const other = await t.openTab(t.origin + '/');
    try {
      await sign(other);
      await other.has('#session-status', 'Токен подключён');
      await other.navigate('payments');
      await payment(other, '11,43', purpose);
      await other.click(submit);
      await other.has('#payment-data', first.response.paymentId);
      const requests = t.calls('POST', PAY).slice(offset);
      assert.equal(requests.length, 2);
      sameKey(first, requests[1]);
      assert.equal(requests[1].response.paymentId, first.response.paymentId);
      assert.equal(t.mock.balances.get(u1), balance - 1143);
    } finally {
      await other.closeTab();
    }
  }),
  test('TRF-01', 'Три фильтра, отправители в карточке, границы суммы и повтор после 502', async t => {
    await list(t, 'transfers');
    await filters(t, { 'from-beneficiary': u3, 'to-beneficiary': u1, deal: uuid(200002) });
    await until(async () => await count(t) === 12, '12 переводов после фильтрации');
    await open(t, 'transfers', uuid(700146));
    await t.has('#transfer-data', u1);
    await t.has('#transfer-data', u3);
    await list(t, 'transfers');
    await resetFilters(t);
    const offset = t.calls('POST', TR).length;
    await transfer(t, { recipient: u1 });
    for (const amount of ['1,001', '0,00', '9999999999999999,99', '-0,01']) {
      await t.fill('#billing-amount', amount);
      await t.click(submit);
      await t.has('#billing-status', 'положительную сумму');
    }
    await t.fill('#billing-amount', '5,19');
    await t.click(submit);
    await t.has('#billing-status', 'разных бенефициаров');
    assert.equal(t.calls('POST', TR).length, offset);
    await t.fill('#billing-to', u3);
    const sender = t.mock.balances.get(u1), recipient = t.mock.balances.get(u3);
    t.after('POST', TR);
    await t.click(submit);
    await t.has('#billing-status', '502');
    await t.click(submit);
    await t.wait('#transfer-panel');
    const [first, retry] = t.calls('POST', TR).slice(offset);
    sameKey(first, retry);
    assert.equal(retry.response.transferId, first.response.transferId);
    assert.equal(t.mock.balances.get(u1), sender - 519);
    assert.equal(t.mock.balances.get(u3), recipient + 519);
  }),
  test('TRF-02', 'Недостаток доступных средств исключает списание', async t => {
    await list(t, 'transfers');
    await transfer(t, { sender: u4, recipient: u1, amount: '0,01' });
    await t.click(submit);
    await t.has('#billing-status', 'Недостаточно доступных средств');
    assert.equal(last(t, 'POST', TR).status, 422);
    assert.equal(t.mock.balances.get(u4), undefined);
    await t.click('#billing-cancel');
  }),
  test('TRF-03', 'Повтор перевода после перезагрузки сохраняет ключ, ID и одно списание', async t => {
    await list(t, 'transfers');
    const balance = t.mock.balances.get(u1), destination = t.mock.balances.get(u3);
    const payload = { amount: '3,14', purpose: 'QA Перевод после перезагрузки' };
    await transfer(t, payload);
    t.after('POST', TR);
    await t.click(submit);
    await t.has('#billing-status', '502');
    const first = last(t, 'POST', TR);
    await reload(t);
    await list(t, 'transfers');
    await transfer(t, payload);
    await t.click(submit);
    await t.has('#transfer-data', first.response.transferId);
    sameKey(first, last(t, 'POST', TR));
    assert.equal(t.mock.balances.get(u1), balance - 314);
    assert.equal(t.mock.balances.get(u3), destination + 314);
  }),
  test('TRF-04', 'Параллельная отправка одинакового перевода из двух вкладок блокируется', async t => {
    await list(t, 'transfers');
    const previous = t.mock.balances.get(u1);
    const form = { amount: '4,33', purpose: 'QA Перевод из двух вкладок' };
    const offset = t.calls('POST', TR).length;
    const other = await t.openTab(t.origin + '/');
    try {
      await sign(other);
      await other.has('#session-status', 'Токен подключён');
      await other.navigate('transfers');
      await transfer(t, form);
      await transfer(other, form);
      t.faults.push({ method: 'POST', path: TR, delay: 1500 });
      await t.click(submit);
      await until(() => other.evaluate(async () => (await navigator.locks.query()).held
        .some(lock => lock.name.startsWith('nominal-accounts-pending:'))), 'блокировка отправляемого перевода');
      await other.click(submit);
      await other.has('#billing-status', 'уже отправляется в другом окне');
      await t.wait('#transfer-panel');
      assert.equal(t.calls('POST', TR).length, offset + 1);
      assert.equal(t.mock.balances.get(u1), previous - 433);
    } finally {
      await other.closeTab();
    }
  }),
];

export const scaleBilling = [billing.find(item => item.id === 'PAY-01')];
