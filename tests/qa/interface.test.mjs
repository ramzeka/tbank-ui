
import { assert, path, test, until, uuid } from './harness.mjs';
import { focus, last, list, ready } from './flows.mjs';

const ST = path.statement;
const queue = '[data-dashboard="queue-content"]';
const totals = '[data-dashboard="operations-stats"]';
const statementSubmit = '#statement-form button[type=submit]';

export const dashboard = test('DASH-01', 'Обзор 7/30 дней, ранний показ очереди, итоговые счетчики и переходы в карточки', async t => {
  await list(t, 'dashboard');
  if (!await t.visible('[data-period="7"]')) await t.click('#dashboard-finance-tab');
  await t.has('[data-dashboard="finance-content"]', 'Остаток на конец периода');
  for (const days of ['7', '30']) {
    const selector = '[data-period="' + days + '"]';
    await t.click(selector);
    await t.has('[data-dashboard="finance-content"]', 'Остаток на конец периода');
    assert.equal(await t.evaluate(selector => document.querySelector(selector).getAttribute('aria-pressed'), selector), 'true');
  }
  t.faults.push({ method: 'GET', path: path.payments, query: { offset: '50' }, delay: 750 });
  const mark = t.calls('GET', path.payments).length;
  const started = Date.now();
  await t.click('#dashboard-operations-tab');
  await t.click('[data-queue="payments"]');
  await t.has(queue, 'Предварительные данные');
  await t.wait(queue + ' table');
  const previewMs = Date.now() - started;
  const previewRequests = t.calls('GET', path.payments).length - mark;
  assert(previewRequests < Math.ceil(t.mock.payments.size / 50));
  await t.evaluate(sel => document.querySelector(sel + ' tbody button').focus(), queue);
  const selected = await t.evaluate(() => document.activeElement.dataset.operationId);
  await until(async () => !(await t.text(queue)).includes('Предварительные данные'), 'полный список выплат', 90000);
  await t.has(queue, 'Показано 5 из');
  assert.equal(await t.evaluate(() => document.activeElement.dataset.operationId), selected);
  const readyMs = Date.now() - started;
  const requests = t.calls('GET', path.payments).length - mark;
  assert.equal(requests, Math.ceil(t.mock.payments.size / 50));
  const failed = [...t.mock.payments.values()].filter(payment => payment.status === 'FAILED').length;
  const number = new Intl.NumberFormat('ru-RU').format(failed);
  await t.has(totals, number);
  await t.click(queue + ' tbody button');
  await t.wait('#payment-panel');
  await list(t, 'dashboard');
  await t.click('[data-queue="incoming"]');
  await t.wait(queue + ' table');
  await t.click(queue + ' tbody button');
  await t.wait('#transaction-panel');
  return { previewMs, readyMs, previewRequests, requests };
});

export const interfaces = [
  test('STMT-01', 'Выписка по курсорам, фильтры, границы периода, МСК и балансы', async t => {
    await list(t, 'statement');
    await t.click(statementSubmit);
    await t.wait('#statement-result table');
    await t.click('#statement-next');
    await until(() => t.calls('GET', ST).some(call => call.url.includes('cursor=')), 'курсор второй страницы');
    await t.click('#statement-prev');
    await t.wait('#statement-result table');
    await t.fill('#statement-form [name=period]', 'custom');
    await t.fill('#statement-from', '2026-11-18T10:15');
    await t.fill('#statement-to', '2026-11-17T11:45');
    const before = t.calls('GET', ST).length;
    await t.click(statementSubmit);
    await t.has('#statement-status', 'позже начала');
    assert.equal(t.calls('GET', ST).length, before);
    await t.fill('#statement-to', '2026-11-24T11:45');
    await t.click('#statement-extra-toggle');
    await t.fill('#statement-form [name=operationStatus]', 'Transaction');
    await t.fill('#statement-form [name=categories]', 'DEMO_CARD, DEMO_CARD');
    await t.fill('#statement-form [name=inns]', '0000000001');
    await t.fill('#statement-form [name=ucid]', '9223372036854775808');
    await t.click(statementSubmit);
    await t.has('#statement-status', 'формате целого числа');
    await t.fill('#statement-form [name=ucid]', '9000000000000000001');
    await t.click('#statement-form [name=withBalances]');
    const mark = t.calls('GET', ST).length;
    await t.click(statementSubmit);
    const request = await until(() => t.calls('GET', ST)[mark], 'выписка с фильтрами');
    const query = new URL(request.url, t.origin).searchParams;
    assert.equal(query.get('from'), '2026-11-18T07:15:00.000Z');
    assert.equal(query.get('to'), '2026-11-24T08:45:00.000Z');
    assert.deepEqual(query.getAll('categories'), ['DEMO_CARD']);
    assert.equal(query.get('inns'), '0000000001');
    assert.equal(query.get('ucid'), '9000000000000000001');
    assert.equal(query.get('operationStatus'), 'Transaction');
    assert.equal(query.get('withBalances'), 'true');
    assert.equal(request.account, undefined);
    await t.wait('#statement-balances');
  }),
  test('STMT-02', 'Повторившийся курсор отклоняется, предыдущая страница остается читаемой', async t => {
    await list(t, 'beneficiaries');
    await list(t, 'statement');
    await t.click(statementSubmit);
    await t.wait('#statement-result table');
    const first = last(t, 'GET', ST);
    const cursor = first.response.nextCursor;
    assert(cursor);
    const table = await t.text('#statement-result');
    t.before('GET', ST, 200, { operations: first.response.operations, nextCursor: cursor }, { query: { cursor } });
    await t.click('#statement-next');
    await t.has('#statement-status', 'курсор');
    assert.equal(await t.text('#statement-result'), table);
  }),
  test('A11Y-01', 'Клавиатура для вкладок и диалогов, доступное имя и восстановление фокуса', async t => {
    await list(t, 'dashboard');
    await t.click('#dashboard-finance-tab');
    await t.evaluate(() => document.querySelector('#dashboard-finance-tab').focus());
    await t.key('ArrowRight', 39);
    assert.equal(await focus(t), 'dashboard-operations-tab');
    assert.equal(await t.evaluate(() => document.querySelector('#dashboard-operations-tab').getAttribute('aria-selected')), 'true');
    await t.key('Home', 36);
    assert.equal(await focus(t), 'dashboard-finance-tab');
    await list(t, 'deals');
    await ready(t, '#deal-create');
    await t.evaluate(() => document.querySelector('#deal-create').focus());
    await t.key('Enter', 13);
    await t.wait('#deal-dialog');
    assert.equal(await focus(t), 'deal-account');
    const tree = (await t.send('Accessibility.getFullAXTree')).nodes;
    assert(tree.some(node => !node.ignored && node.role?.value === 'dialog' && node.name?.value === 'Создать сделку'));
    await t.key('Escape', 27);
    await t.gone('#deal-dialog');
    assert.equal(await focus(t), 'deal-create');
    await list(t, 'payments');
    await t.evaluate(() => document.querySelector('#billing-filter-button').focus());
    await t.key('Enter', 13);
    await t.wait('#billing-filters-dialog');
    await t.key('Escape', 27);
    await t.gone('#billing-filters-dialog');
    assert.equal(await focus(t), 'billing-filter-button');
  }),
  test('A11Y-02', 'Платежи при 320 CSS-пикселях и прокрутка таблицы клавишами', async t => {
    await list(t, 'payments');
    await t.wait('#result table');
    await t.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    try {
      const layout = await t.evaluate(() => {
        const container = document.querySelector('#result');
        document.querySelector('#payment-search button[type=submit]').focus();
        return { width: container.clientWidth, content: container.scrollWidth, root: document.documentElement.scrollWidth,
          viewport: innerWidth, scope: container.querySelector('th').scope };
      });
      await t.key('Tab', 9);
      assert(await t.evaluate(() => document.querySelector('#result').contains(document.activeElement)));
      for (let index = 0; index < 8; index++) await t.key('ArrowRight', 39);
      await until(() => t.evaluate(() => document.querySelector('#result').scrollLeft > 0), 'горизонтальная прокрутка');
      assert(layout.content > layout.width);
      assert(layout.root <= layout.viewport + 1);
      assert.equal(layout.scope, 'col');
      return layout;
    } finally {
      await t.send('Emulation.clearDeviceMetricsOverride');
    }
  }),
  test('A11Y-04', 'Календарь выписки открывается клавиатурой и возвращает фокус после Escape', async t => {
    await list(t, 'statement');
    const control = '[data-date-for="statement-from"]';
    await t.evaluate(selector => document.querySelector(selector).focus(), control);
    await t.key('Enter', 13);
    await t.wait('#statement-calendar');
    assert(await t.evaluate(() => document.activeElement.closest('#calendar-days') !== null));
    await t.key('Escape', 27);
    await t.gone('#statement-calendar');
    assert(await t.evaluate(selector => document.activeElement.matches(selector), control));
  }),
];
