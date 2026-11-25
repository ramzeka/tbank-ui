
import { assert, path, test, until, uuid } from './harness.mjs';
import { focus, last, list, ready, reload } from './flows.mjs';

const ST = path.statement;
const statementSubmit = '#statement-form button[type=submit]';

export const dashboard = test('DASH-01', 'Неидентифицированные пополнения и финансовый обзор без обхода страниц', async t => {
  if (await t.visible('#refresh')) await ready(t, '#refresh');
  const IN = path.incoming;
  const entries = [
    { operationId: uuid(930001), transactionDate: '2026-11-22T21:30:00Z', amount: '125.50', currency: '643', payerName: 'Тестовый плательщик' },
    { operationId: uuid(930002), transactionDate: '2026-11-23', amount: '35.01', currency: 'RUB' },
    { operationId: uuid(930003), transactionDate: '2026-11-22T20:59:00Z', amount: '41.00', currency: 'RUB' },
  ];
  t.before('GET', IN, 200, { results: entries, total: 3 });
  const mark = t.trace.length;
  const calls = () => t.trace.slice(mark).map(call => call.path);
  const support = '[data-dashboard="support-content"]';
  const finance = '[data-dashboard="finance-content"]';
  const status = '[data-dashboard="status"]';
  await reload(t);
  await t.has(support, '201,51');
  await t.has(support, 'Общая сумма');
  const groups = await t.evaluate(selector => Array.from(document.querySelectorAll(selector + ' tbody tr'),
    row => Array.from(row.cells, cell => cell.textContent)), support);
  assert.deepEqual(groups.map(([, value]) => value), ['2', '1']);
  assert.match(groups[0][0], /^23/);
  assert.match(groups[1][0], /^22/);
  assert.equal(await t.evaluate(() => document.querySelector('[role="tablist"] [aria-selected=true]').textContent), 'Поддержка');
  assert.deepEqual(calls(), [IN]);
  const initial = last(t, 'GET', IN);
  const query = new URL(initial.url, t.origin).searchParams;
  assert.equal(query.get('limit'), '50');
  assert.equal(query.get('offset'), '0');
  assert.equal(initial.account, uuid(990));

  await t.click('[data-dashboard="incoming-link"]');
  await t.has('#result', 'Тестовый плательщик');
  await list(t, 'dashboard');
  assert.deepEqual(calls(), [IN]);
  t.before('GET', IN, 200, { results: entries, total: 120 });
  await t.click('[data-dashboard="refresh"]');
  await t.has(status, 'из 120 пополнений');
  await t.has(support, 'Сумма загруженных пополнений');
  assert.deepEqual(calls(), [IN, IN]);

  const credit = {
    operationId: uuid(920700), operationDate: new Date(Date.now() - 3600000).toISOString(),
    typeOfOperation: 'Credit', operationStatus: 'Transaction',
    accountAmount: 125.5, accountCurrencyDigitalCode: '643', payer: { name: 'Тестовый плательщик' },
  };
  const operations = [credit,
    { ...credit, operationId: uuid(920701), typeOfOperation: 'Debit', accountAmount: 41 },
    { ...credit, operationId: uuid(920702), operationStatus: 'Authorization', accountAmount: 999 },
  ];
  t.before('GET', ST, 200, { operations, nextCursor: 'unread-page' });
  await t.click('#dashboard-finance-tab');
  await t.has(finance, '125,50');
  await t.has(finance, '41');
  await t.has(finance, 'Движение денег');
  await t.has(finance, 'Последние операции');
  await t.has(status, 'Показатели рассчитаны по загруженным данным');
  assert(!/остаток|999/i.test(await t.text(finance)));
  assert.deepEqual(calls(), [IN, IN, ST]);
  const request = new URL(last(t, 'GET', ST).url, t.origin).searchParams;
  assert.equal(request.get('limit'), '5000');
  assert.equal(request.get('operationStatus'), 'Transaction');
  assert.equal(request.has('withBalances') || request.has('cursor'), false);

  await t.click('[data-period="30"]');
  await t.has(finance, 'Последние операции');
  await t.click('[data-period="7"]');
  await t.has(finance, '125,50');
  await t.click('#dashboard-support-tab');
  await t.has(support, '201,51');
  assert.deepEqual(calls(), [IN, IN, ST, ST]);
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
    assert.equal(request.account, uuid(990));
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
    assert.equal(await focus(t), 'dashboard-support-tab');
    assert.equal(await t.evaluate(() => document.querySelector('#dashboard-support-tab').getAttribute('aria-selected')), 'true');
    await t.key('End', 35);
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
