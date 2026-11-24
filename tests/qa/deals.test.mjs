
import { assert, path, test, until, uuid } from './harness.mjs';
import { u1, u2, u3, u4, list, open, deal, step, identify, stepsPath, stepPath, openStep, partyGroup, party, last, sameKey, confirmAction } from './flows.mjs';

const { deals: D, payments: PAY } = path;
const dealStatus = '#deal-status', stepStatus = '#step-status';
const transition = (t, action, text, target = dealStatus) => confirmAction(t, '#' + action, target, text);
const openParty = (t, kind, id) => t.clickText(partyGroup(kind) + ' [data-part=table]', id);

async function saveParty(t) {
  await t.click('#party-save');
  await t.gone('#party-dialog');
}

async function complete(t, route) {
  await transition(t, 'step-complete', 'завершение этапа принят', stepStatus);
  assert.equal((await t.relay(route)).data.status, 'COMPLETED');
}

export const deals = [
  test('DEAL-01', 'Создание сделки и этапа с повтором после 502, чтение, изменение и удаление этапа', async t => {
    const count = t.calls('POST', D).length;
    t.after('POST', D);
    await list(t, 'deals');
    await t.click('#deal-create');
    await transition(t, 'deal-save', '502', '#deal-editor-status');
    await transition(t, 'deal-save', 'Сделка создана');
    const [first, replay] = t.calls('POST', D).slice(count);
    sameKey(first, replay);
    const dealId = first.response.dealId;
    assert.equal(replay.response.dealId, dealId);
    await transition(t, 'deal-validate', 'NO_STEPS_IN_DEAL', '#deal-validation');
    const route = stepsPath(dealId);
    t.after('POST', route);
    await t.click('#step-create');
    await t.fill('#step-description', '   ');
    await transition(t, 'deal-save', 'длиной от 3', '#deal-editor-status');
    assert.equal(t.calls('POST', route).length, 0);
    await t.fill('#step-description', 'QA Рабочий этап');
    await transition(t, 'deal-save', '502', '#deal-editor-status');
    await transition(t, 'deal-save', 'Этап добавлен', stepStatus);
    const [created, retry] = t.calls('POST', route);
    sameKey(created, retry);
    const stepId = created.response.stepId;
    assert.equal(retry.response.stepId, stepId);
    await t.click('#step-edit');
    await t.fill('#step-description', 'QA Обновленный этап');
    await transition(t, 'deal-save', 'Этап обновлён', stepStatus);
    assert.equal(last(t, 'PUT', route + '/' + stepId).body.description, 'QA Обновленный этап');
    const obsolete = await step(t, dealId, 'QA Для удаления');
    await transition(t, 'step-delete', 'Этап удалён', stepStatus);
    assert.equal((await t.relay(route + '/' + obsolete)).status, 404);
    await openStep(t, stepId);
    await t.has('#step-data', 'Обновленный этап');
  }),
  test('PARTY-01', 'Депонент через PUT, единственная строка, чтение, изменение и удаление', async t => {
    const dealId = await deal(t);
    const stepId = await step(t, dealId, 'QA Депоненты');
    const route = stepPath(dealId, stepId) + '/deponents';
    for (const amount of ['1,23', '2,34']) {
      await party(t, 'deponents', u4, amount);
      await saveParty(t);
      await t.has(partyGroup('deponents') + ' table', amount);
    }
    assert.equal((await t.relay(route)).data.total, 1);
    await openParty(t, 'deponents', u4);
    await t.clickText('#deponents-detail-' + u4, 'Редактировать');
    await t.fill('#party-amount', '3,45');
    await saveParty(t);
    await t.has(partyGroup('deponents') + ' table', '3,45');
    await openParty(t, 'deponents', u4);
    await t.clickText('#deponents-detail-' + u4, 'Удалить');
    await until(() => last(t, 'DELETE', route + '/' + u4)?.status === 200, 'депонент удален');
    assert.equal((await t.relay(route + '/' + u4)).status, 404);
  }),
  test('PARTY-02', 'Реципиент с повтором после 502, две строки одного бенефициара и удаление одной', async t => {
    const dealId = await deal(t);
    const stepId = await step(t, dealId, 'QA Реципиенты');
    const route = stepPath(dealId, stepId) + '/recipients';
    t.after('POST', route);
    await party(t, 'recipients', u3, '12,01');
    await t.click('#party-lookup');
    await t.has('#party-lookup-status', 'Лада');
    await transition(t, 'party-save', '502', '#party-editor-status');
    await t.click('#party-form-cancel');
    await party(t, 'recipients', u3, '12,01');
    await saveParty(t);
    const [first, retry] = t.calls('POST', route);
    sameKey(first, retry);
    const id = first.response.recipientId;
    assert.equal(retry.response.recipientId, id);
    await t.has(partyGroup('recipients') + ' table', '12,01');
    await party(t, 'recipients', u3, '22,02');
    await saveParty(t);
    await t.has(partyGroup('recipients') + ' table', '22,02');
    assert.equal((await t.relay(route)).data.total, 2);
    await openParty(t, 'recipients', u3);
    await t.clickText('#recipients-detail-' + id, 'Редактировать');
    await t.fill('#party-amount', '1,23');
    await saveParty(t);
    await t.has(partyGroup('recipients') + ' table', '1,23');
    await openParty(t, 'recipients', u3);
    await t.clickText('#recipients-detail-' + id, 'Удалить');
    await until(() => last(t, 'DELETE', route + '/' + id)?.status === 200, 'реципиент удален');
    assert.equal((await t.relay(route + '/' + id)).status, 404);
    assert.equal((await t.relay(route)).data.total, 1);
  }),
  test('DEAL-02', 'Изменение статуса, запреты вне черновика и расчет на виртуальный счет', async t => {
    const dealId = await deal(t);
    const stepId = await step(t, dealId, 'QA Выплата на виртуальный счет');
    const route = stepPath(dealId, stepId);
    await party(t, 'deponents', u1, '22,02');
    await saveParty(t);
    await party(t, 'recipients', u3, '22,02');
    await saveParty(t);
    assert.equal(await t.visible('#step-complete'), false);
    await transition(t, 'deal-accept', 'подтверждены');
    await openStep(t, stepId);
    assert.equal(await t.visible('#step-edit'), false);
    assert.equal(await t.visible(partyGroup('deponents') + ' [data-action=add]'), false);
    assert.equal((await t.relay(route, { method: 'PUT', body: { description: 'QA Запрещенное изменение' } })).status, 422);
    assert.equal((await t.relay(route + '/deponents/' + u1, { method: 'DELETE' })).status, 422);
    await transition(t, 'deal-draft', 'в черновик');
    await openStep(t, stepId);
    await t.wait('#step-edit');
    await transition(t, 'deal-accept', 'подтверждены');
    await transition(t, 'deal-validate', 'Выплаты возможны', '#deal-validation');
    await openStep(t, stepId);
    const sender = t.mock.balances.get(u1), recipient = t.mock.balances.get(u3);
    await complete(t, route);
    assert.equal((await t.relay(D + '/' + dealId)).data.status, 'COMPLETED');
    assert.equal((await t.relay(route + '/complete', { method: 'POST' })).status, 422);
    assert.equal(t.mock.balances.get(u1), sender - 2202);
    assert.equal(t.mock.balances.get(u3), recipient + 2202);
  }),
  test('DEAL-03', 'Пополнение после нехватки средств, выплата на банк и чтение связанного платежа до исполнения', async t => {
    const dealId = await deal(t);
    const stepId = await step(t, dealId, 'QA От пополнения до банковской выплаты');
    const route = stepPath(dealId, stepId);
    await party(t, 'deponents', u4, '122,33');
    await saveParty(t);
    await party(t, 'recipients', u1, '122,33');
    await t.fill('#party-destination', 'bank');
    await t.click('#party-lookup');
    await t.has('#party-lookup-status', 'Атлас');
    await t.fill('#party-bank', uuid(502));
    await t.fill('#party-purpose', 'QA Выплата по сделке');
    await saveParty(t);
    const receiver = last(t, 'POST', route + '/recipients').response;
    await transition(t, 'deal-accept', 'подтверждены');
    await transition(t, 'deal-validate', 'DEMO_INSUFFICIENT_FUNDS', '#deal-validation');
    await openStep(t, stepId);
    await transition(t, 'step-complete', '422', stepStatus);
    await identify(t, uuid(803), u4);
    await t.click('#identify-submit');
    await t.gone('#identify-dialog');
    await list(t, 'deals');
    await open(t, 'deals', dealId);
    await transition(t, 'deal-validate', 'Выплаты возможны', '#deal-validation');
    await openStep(t, stepId);
    const sender = t.mock.balances.get(u4), recipient = t.mock.balances.get(u1);
    await complete(t, route);
    assert.equal(t.mock.balances.get(u4), sender - 12233);
    assert.equal(t.mock.balances.get(u1), recipient);
    await t.click('#step-payments');
    await t.has('#result', 'QA Выплата по сделке');
    const related = [...t.mock.payments.values()].filter(payment => payment.dealId === dealId);
    assert.equal(related.length, 1);
    const [payment] = related;
    assert.equal(payment.stepId, stepId);
    assert.equal(payment.recipientId, receiver.recipientId);
    assert.equal(payment.bankDetails.bankDetailsId, uuid(502));
    assert.equal(payment.amount, 122.33);
    await t.clickText('#result', payment.paymentId);
    await t.has('#payment-data', 'В процессе');
    t.mock.payments.set(payment.paymentId, { ...payment, status: 'SUCCEEDED', operationId: uuid(9988) });
    await list(t, 'payments');
    await open(t, 'payments', payment.paymentId);
    await t.has('#payment-data', 'Исполнен');
    assert.equal(last(t, 'GET', PAY + '/' + payment.paymentId).response.operationId, uuid(9988));
    await list(t, 'payments');
    await t.click('#billing-filter-button');
    await t.click('#billing-filters-reset');
  }),
  test('DEAL-04', 'Восстановление выплаты после ошибки с заменой реквизитов', async t => {
    const dealId = uuid(200006), stepId = uuid(300501), recipientId = uuid(400501);
    const route = stepPath(dealId, stepId);
    await list(t, 'deals');
    await open(t, 'deals', dealId);
    await openStep(t, stepId);
    await t.click('#step-payments');
    await t.has('#result', uuid(500002));
    await list(t, 'deals');
    await open(t, 'deals', dealId);
    await openStep(t, stepId);
    await openParty(t, 'recipients', u1);
    await t.clickText('#recipients-detail-' + recipientId, 'Обновить реквизиты');
    await t.fill('#party-bank', uuid(999999));
    await transition(t, 'party-save', '422', '#party-editor-status');
    await t.fill('#party-bank', uuid(502));
    await saveParty(t);
    const recipient = route + '/recipients/' + recipientId;
    assert.equal(last(t, 'POST', recipient + '/update-bank-details').status, 200);
    assert.equal((await t.relay(recipient)).data.bankDetailsId, uuid(502));
    await transition(t, 'deal-validate', 'Выплаты возможны', '#deal-validation');
    if (!await t.visible('#step-complete')) await openStep(t, stepId);
    await complete(t, route);
  }),
  test('DEAL-05', 'Отмена, удаление черновика и пагинация этапов и участников', async t => {
    const obsolete = await deal(t);
    await transition(t, 'deal-delete', 'Сделка удалена', '#deal-list-feedback');
    assert.equal((await t.relay(D + '/' + obsolete)).status, 404);
    const cancelled = await deal(t);
    await transition(t, 'deal-cancel', 'Сделка отменена');
    assert.equal((await t.relay(D + '/' + cancelled)).data.status, 'CANCELLED');
    assert.equal(await t.visible('#deal-delete'), false);
    const dealId = uuid(200007), stepId = uuid(300601);
    await list(t, 'deals');
    await open(t, 'deals', dealId);
    await openStep(t, stepId);
    for (const kind of ['deponents', 'recipients']) {
      const route = stepPath(dealId, stepId) + '/' + kind;
      await t.click(partyGroup(kind) + ' [data-action=next]');
      const page = await until(() => t.calls('GET', route).find(call => call.url.includes('offset=50')), 'вторая страница участников');
      assert.equal(page.response.results.length, 3);
    }
    await t.click('#step-next');
    await t.has('#step-list', 'Этап проектирования 53');
    await t.click('#step-prev');
    await t.has('#step-list', 'Этап проектирования 1');
  }),
  test('DEAL-06', 'Несовпадающие суммы и запрет подтверждения сделки с неполным расчетом', async t => {
    const dealId = await deal(t);
    const stepId = await step(t, dealId, 'QA Несовпадение сумм');
    const route = stepPath(dealId, stepId);
    await party(t, 'deponents', u1, '10,02');
    await saveParty(t);
    await party(t, 'recipients', u2, '10,01');
    await saveParty(t);
    await transition(t, 'deal-validate', 'DEMO_AMOUNT_MISMATCH', '#deal-validation');
    await transition(t, 'deal-accept', '422');
    assert.equal((await t.relay(D + '/' + dealId)).data.status, 'DRAFT');
    assert.equal((await t.relay(route)).data.status, 'NEW');
  }),
];
