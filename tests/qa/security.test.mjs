
import { assert, api, path, test, testToken, secondToken, demoAccount, uuid, requestLocal, until } from './harness.mjs';
import { u3, entity, list, open, sign, settings, org, focus, last, payment, openStep, party, sameKey, reload } from './flows.mjs';

const B = path.beneficiaries;
export const login = test('AUTH-01', 'Вход с неверным и действующим токеном, память сеанса', async t => {
  await settings(t);
  await sign(t, 'incorrect-demo');
  await t.has('#session-status', '401');
  await sign(t);
  await t.has('#session-status', 'Токен подключён');
  await list(t, 'beneficiaries');
  await t.has('#result', 'Атлас');
  assert.equal(last(t, 'GET', B).account, uuid(990));
  assert.deepEqual(await t.evaluate(token => [
    document.querySelector('#access-token').value,
    Object.values(localStorage).some(value => value.includes(token)),
    Object.values(sessionStorage).some(value => value.includes(token)),
  ], testToken), ['', false, false]);
});

export const security = [
  test('SEC-01', 'Отклонение некорректных запросов на локальном прокси и защитные заголовки', async t => {
    const samples = [
      [403, { headers: { 'X-TBank-Run': null } }],
      [403, { headers: { Origin: 'http://127.0.0.1:2' } }],
      [403, { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
      [400, { headers: { Authorization: null } }],
      [400, { headers: { bankAccountId: 'not-a-uuid' } }],
      [400, { headers: { 'X-TBank-Proxy-Origin': 'https://developer.tbank.ru' } }],
      [405, { method: 'PATCH', body: {} }],
      [400, { method: 'POST', body: {}, headers: { 'Idempotency-Key': 'not-a-uuid' } }],
      [400, { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } }],
      [403, { method: 'POST', body: {}, headers: { Origin: null } }],
      [400, { headers: { Host: 'localhost:8765' } }],
    ];
    const offset = t.trace.length;
    for (const [status, options] of samples) assert.equal((await t.relay(B, options)).status, status, JSON.stringify(options));
    assert.equal(t.trace.slice(offset).filter(request => request.path === B).length, 0);
    const wrapped = await t.relay(B, { headers: { Authorization: 'Bearer invalid-operator' } });
    assert.equal(wrapped.http, 200);
    assert.equal(wrapped.status, 401);
    const page = await requestLocal(t.origin + '/');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(page.headers['content-security-policy'], /connect-src 'self'.*frame-ancestors 'none'/);
    return { rejectedAtRelay: samples.length };
  }),
  test('SEC-02', '401 при записи полностью очищает паспорт, адрес и черновик другого сеанса', async t => {
    await list(t, 'beneficiaries');
    await open(t, 'beneficiaries', u3);
    await t.click('#beneficiary-edit');
    await entity(t, { email: 'qa-private-draft@example.org' });
    t.before('PUT', B + '/' + u3, 401, { errorMessage: 'QA: срок истёк' });
    await t.click('#entity-save');
    await t.has('#session-status', '401');
    await t.gone('#entity-editor');
    assert.deepEqual(await t.evaluate(() => ({
      fields: document.querySelector('#entity-fields').childElementCount,
      owner: document.querySelector('#entity-owner').textContent,
      card: document.querySelector('#beneficiary-data').childElementCount,
    })), { fields: 0, owner: '', card: 0 });
    assert.equal(await focus(t), 'settings-link');
    await sign(t, secondToken);
    await t.wait('#result table');
    await t.gone('#entity-editor');
    await open(t, 'beneficiaries', u3);
    await t.click('#beneficiary-edit');
    assert.notEqual(await t.evaluate(() => document.querySelector('#entity-fields [name=email]').value), 'qa-private-draft@example.org');
    await t.click('#entity-cancel');
  }),
  test('SEC-03', '401 при идентификации очищает значения и сводку закрытого диалога', async t => {
    const id = uuid(100057);
    await list(t, 'incoming-transactions');
    await open(t, 'incoming-transactions', id);
    await t.clickText('#transaction-actions', 'Идентифицировать');
    await t.fill('#distribution-rows [name=beneficiaryId]', u3);
    t.before('POST', path.incoming + '/' + id + '/identify', 401, { errorMessage: 'QA: сроки сеанса' });
    await t.click('#identify-submit');
    await t.has('#session-status', '401');
    await t.gone('#identify-dialog');
    assert.deepEqual(await t.evaluate(() => ['identify-summary', 'distribution-rows', 'distribution-total', 'distribution-left']
      .map(id => document.getElementById(id).innerHTML)), ['', '', '', '']);
    await sign(t);
    await t.has('#session-status', 'Токен подключён');
    await open(t, 'incoming-transactions', id);
    await t.clickText('#transaction-actions', 'Идентифицировать');
    assert.equal(await t.evaluate(() => document.querySelector('#distribution-rows [name=beneficiaryId]').value), '');
    await t.click('#identify-cancel');
  }),
  test('SEC-04', 'UI и relay принимают только адрес прокси из настроек запуска', async t => {
    const alternate = 'http://127.0.0.1:1';
    const offset = t.calls('GET', B).length;
    const denied = await t.relay(B, { headers: { 'X-TBank-Proxy-Origin': alternate } });
    assert.equal(denied.http, 403);
    assert.match(denied.data.message, /not approved/);
    assert.equal(t.calls('GET', B).length, offset);
    await t.click('#settings-link');
    assert.deepEqual(await t.evaluate(() => ['proxy', 'prefix'].map(id => document.getElementById(id).readOnly)),
      [true, true]);
    assert.equal(await t.evaluate(() => new URL(JSON.parse(localStorage.getItem('nominal-accounts-settings:mock')).proxy).origin), t.mock.origin);
    await settings(t);
    await list(t, 'beneficiaries');
    await t.has('#result', 'Атлас');
  }),
  test('SEC-05', 'Транспортный 401 завершает сеанс и очищает дисплей платежа при коде успеха в теле', async t => {
    await list(t, 'payments');
    await payment(t, '13,45', 'QA Очистка назначения');
    const before = t.mock.payments.size;
    t.before('POST', path.payments, 401, { responseCode: 201, responseBody: {} }, { http: 401 });
    await t.click('#billing-submit');
    await t.has('#session-status', 'HTTP 401');
    await t.gone('#billing-dialog');
    assert.equal(t.mock.payments.size, before);
    assert.deepEqual(await t.evaluate(() => ({
      values: ['billing-from', 'billing-amount', 'billing-purpose'].map(id => document.getElementById(id).value),
      options: document.querySelector('#billing-bank').options.length,
      status: document.querySelector('#billing-bank-status').textContent,
    })), { values: ['', '', ''], options: 1, status: '' });
    await sign(t);
    await t.has('#session-status', 'Токен подключён');
  }),
  test('SEC-06', 'Выход очищает значения закрытой формы реципиента', async t => {
    await list(t, 'deals');
    await open(t, 'deals', uuid(200001));
    await openStep(t, uuid(300001));
    await party(t, 'recipients', u3, '19,10');
    await t.fill('#party-purpose', 'QA Назначение');
    await t.click('#party-form-cancel');
    await t.click('#settings-link');
    await t.click('#logout');
    await t.has('#session-status', 'сеанс завершён');
    assert.deepEqual(await t.evaluate(() => [
      ...['party-beneficiary', 'party-amount', 'party-purpose'].map(id => document.getElementById(id).value),
      document.querySelector('#party-bank-options').options.length,
    ]), ['', '', '', 0]);
    await sign(t);
    await t.has('#session-status', 'Токен подключён');
  }),
  test('SEC-07', 'Relay пропускает только явно разрешённые методы и пути', async t => {
    const offset = t.trace.length;
    const blocked = [
      [B + '-test', 'GET', 405],
      ['/qa-gateway' + B, 'GET', 405],
      [B + '/invalid-id', 'GET', 405],
      [B + '/', 'GET', 400],
      [B.toUpperCase(), 'GET', 405],
      [path.statement, 'POST', 405],
      [path.payments + '/' + uuid(500001), 'PUT', 405],
    ];
    for (const [route, method, status] of blocked) {
      assert.equal((await t.relay(route, { method })).http, status, method + ' ' + route);
    }
    assert.deepEqual(t.trace.slice(offset).filter(call =>
      blocked.some(([route, method]) => call.path === route && call.method === method)), []);
    assert.equal((await t.relay(B + '?offset=0&limit=10')).status, 200);
  }),
  test('SEC-08', 'Карточка и ошибки не показывают служебные поля ответа', async t => {
    const id = uuid(500005);
    const route = path.payments + '/' + id;
    const internal = 'QA_INTERNAL_ONLY';
    const item = t.mock.payments.get(id);
    t.before('GET', route, 200, {
      ...item, routingMetadata: internal, purpose: { note: internal },
      bankDetails: { ...item.bankDetails, terminalKey: internal, payerStatus: internal },
      tax: { ...item.tax, thirdParty: { ...item.tax.thirdParty, debug: internal } },
    });
    await list(t, 'payments');
    await open(t, 'payments', id);
    await t.has('#payment-data', item.bankDetails.name);
    await t.has('#payment-data', 'КБК');
    assert.doesNotMatch(await t.text('#payment-data'), /QA_INTERNAL_ONLY|routingMetadata|terminalKey/);
    await list(t, 'payments');
    const requestId = uuid(908001);
    t.before('GET', route, 422, {
      errorCode: 'INVALID_PAYMENT', requestId, errorMessage: internal, errorDetails: { hidden: internal },
    });
    await t.fill('#payment-search-id', id);
    await t.click('#payment-search button[type=submit]');
    await t.has('#payment-search-status', requestId);
    await t.has('#payment-search-status', 'INVALID_PAYMENT');
    assert.doesNotMatch(await t.text('#payment-search-status'), /QA_INTERNAL_ONLY/);
  }),
  test('SEC-09', 'Миграция удаляет параметры URL и сохраняет защиту незавершённой операции', async t => {
    const accountId = uuid(990);
    const key = 'nominal-accounts-settings:mock';
    const pending = 'nominal-accounts-pending:' + '1'.repeat(64);
    const remember = (tab, url) => tab.evaluate((key, url, pending, accountId, accountNumber) => {
      localStorage.setItem(key, JSON.stringify({
        proxy: url, prefix: '/api/v1/nominal-accounts', bankAccountId: accountId, accountNumber,
      }));
      localStorage.setItem('nominal-accounts-settings:dev', JSON.stringify({
        proxy: 'https://dev.example.invalid?qa=DEMO_ONLY',
      }));
      sessionStorage.setItem(pending, accountId);
    }, key, url, pending, accountId, demoAccount);
    await t.withStartupConfig('', { mockOrigin: t.mock.origin }, async relay => {
      const tab = await t.openTab(relay.origin + '/');
      try {
        await tab.wait('#settings-link');
        await remember(tab, t.mock.origin + '/?qa=DEMO_ONLY');
        await tab.send('Page.navigate', { url: relay.origin + '/?migration-check=1' });
        await until(() => tab.evaluate(key => location.search === '?migration-check=1' &&
          JSON.parse(localStorage.getItem(key))?.reconcilePending === true, key), 'миграция настроек');
        assert.deepEqual(await tab.evaluate((key, pending) => [
          Object.values(localStorage).some(value => value.includes('DEMO_ONLY')),
          JSON.parse(localStorage.getItem(key)).reconcilePending,
          sessionStorage.getItem(pending),
        ], key, pending), [false, true, accountId]);
        await sign(tab);
        await list(tab, 'payments');
        await payment(tab);
        const before = t.calls('POST', path.payments).length;
        await tab.click('#billing-submit');
        await tab.has('#billing-status', 'Сверьте незавершённые операции');
        assert.equal(t.calls('POST', path.payments).length, before);
      } finally {
        await tab.closeTab();
      }
    });
  }),
  test('IDEM-01', 'Одновременный повтор с тем же ключом, конфликт, отсутствие ключа и неподдерживаемое удаление', async t => {
    const body = { type: 'LITE_CONTACT' };
    const offset = t.calls('POST', B).length;
    assert.equal((await t.relay(B, { method: 'POST', body })).status, 400);
    assert.equal(t.calls('POST', B).length, offset);
    const key = crypto.randomUUID();
    const options = { method: 'POST', body, headers: { 'Idempotency-Key': key } };
    const old = t.mock.people.size;
    const [first, second] = await Promise.all([t.relay(B, options), t.relay(B, options)]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.data.beneficiaryId, second.data.beneficiaryId);
    assert.equal(t.mock.people.size, old + 1);
    assert.equal((await t.relay(B, { ...options, body: { ...body, email: 'qa-conflict@example.org' } })).status, 409);
    assert.equal((await t.relay(B + '/' + first.data.beneficiaryId, { method: 'DELETE' })).status, 405);
  }),
  test('IDEM-02', 'Запись блокируется при недоступном хранилище ключей, затем штатно повторяется', async t => {
    await list(t, 'beneficiaries');
    await org(t, 'QA Хранилище недоступно');
    await t.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.qaRestoreStorage = () => { Storage.prototype.setItem = original; delete window.qaRestoreStorage; };
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key.startsWith('nominal-accounts-pending:')) throw new DOMException('QA', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    const offset = t.calls('POST', B).length;
    try {
      await t.click('#entity-save');
      await t.has('#entity-status', 'не может сохранить ключ операции');
      assert.equal(t.calls('POST', B).length, offset);
    } finally {
      await t.evaluate(() => window.qaRestoreStorage());
    }
    await t.click('#entity-save');
    await t.has('#beneficiary-feedback', 'Бенефициар создан');
    assert.equal(t.calls('POST', B).length, offset + 1);
  }),
  test('IDEM-03', 'Ключ незавершённой операции из прежней версии переносится без дубля', async t => {
    await list(t, 'beneficiaries');
    const name = 'QA Ключ прежней версии';
    const old = t.mock.people.size;
    await org(t, name);
    t.after('POST', B);
    await t.click('#entity-save');
    await t.has('#entity-status', 'HTTP 502');
    const first = last(t, 'POST', B);
    const slot = await t.evaluate(key => {
      const entry = Object.entries(localStorage).find(([name, value]) => name.startsWith('nominal-accounts-pending:') && value === key);
      sessionStorage.setItem(entry[0], entry[1]);
      localStorage.removeItem(entry[0]);
      return entry[0];
    }, first.key);
    await t.click('#entity-cancel');
    await reload(t);
    await list(t, 'beneficiaries');
    await org(t, name);
    await t.click('#entity-save');
    await t.has('#beneficiary-feedback', 'Бенефициар создан');
    sameKey(first, last(t, 'POST', B));
    assert.equal(t.mock.people.size, old + 1);
    assert.deepEqual(await t.evaluate(key => [localStorage.getItem(key), sessionStorage.getItem(key)], slot), [null, null]);
  }),
  test('AUTH-02', 'Токен с истекшим exp, выход и закрытие данных после ошибки сеанса', async t => {
    await list(t, 'beneficiaries');
    await t.has('#result', 'Атлас');
    t.before('GET', B, 401, { errorMessage: 'QA: истёк срок' });
    await t.click('#refresh');
    await t.has('#session-status', '401');
    await t.gone('#result table');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 })).toString('base64url');
    await sign(t, 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.test');
    await t.has('#token-status', 'истёк');
    await sign(t);
    await t.wait('#result table');
    await t.click('#settings-link');
    await t.click('#logout');
    await t.has('#session-status', 'Локальный сеанс завершён');
    assert.equal(await focus(t), 'access-token');
    await sign(t);
    await t.has('#session-status', 'Токен подключён');
  }),
  test('AUTH-03', 'Короткий номер, переводы без номера и выписка при 22 цифрах', async t => {
    await settings(t, { account: '123' });
    await t.has('#settings-status', '20 или 22 цифр');
    await settings(t, { account: '' });
    await sign(t);
    const before = t.calls('GET', path.transfers).length;
    await list(t, 'transfers');
    await t.has('#request-status', 'Укажите номер номинального счёта');
    assert.equal(t.calls('GET', path.transfers).length, before);
    await settings(t, { account: '00' + demoAccount });
    await sign(t);
    await list(t, 'dashboard');
    await t.has('[data-dashboard="status"]', '20-значный номер');
    await list(t, 'statement');
    assert.equal(await t.evaluate(() => document.querySelector('#statement-form [name=accountNumber]').value), '');
    await settings(t);
    await sign(t);
  }),
  test('AUTH-04', 'Сконфигурированный префикс шлюза работает для списка, скоринга и выписки', async t => {
    await t.withStartupConfig('', { mockOrigin: t.mock.origin + '/qa-gateway' }, async relay => {
      const tab = await t.openTab(relay.origin + '/');
      try {
        await settings(tab);
        await sign(tab);
        await list(tab, 'beneficiaries');
        await tab.has('#result', 'Атлас');
        const request = last(t, 'GET', '/qa-gateway' + B);
        assert.equal(new URL(request.url, t.origin).searchParams.get('offset'), '0');
        await open(tab, 'beneficiaries', u3);
        const mark = t.calls('GET', '/qa-gateway' + path.scoring).length;
        await tab.click('#scoring-check');
        await until(() => tab.text('#scoring-result'), 'скоринг через префикс');
        assert.equal(t.calls('GET', '/qa-gateway' + path.scoring).length, mark + 1);
        await list(tab, 'statement');
        await tab.click('#statement-form button[type=submit]');
        await tab.wait('#statement-result table');
        assert.equal(last(t, 'GET', '/qa-gateway' + path.statement).account, uuid(990));
      } finally {
        await tab.closeTab();
      }
    });
  }),
  test('RELAY-01', 'Перегруженный локальный прокси автоматически повторяет чтение', async t => {
    await list(t, 'beneficiaries');
    await t.has('#result', 'Атлас');
    const offset = t.calls('GET', B).length;
    t.before('GET', B, 503, { message: 'Local server is busy.' }, { http: 503 });
    await t.click('#refresh');
    await until(() => t.calls('GET', B).length >= offset + 2, 'повтор чтения');
    assert.deepEqual(t.calls('GET', B).slice(offset).map(call => call.status), [503, 200]);
  }),
  test('RELAY-02', 'Запуск читает proxy.cfg, учитывает явный режим и принимает прежний файл', async t => {
    const dev = 'https://dev.example.invalid:8443';
    const stage = 'https://stage.example.invalid';
    const override = 'https://override.example.invalid';
    const customPrefix = '/custom/v1/nominal-accounts';
    const prod = 'https://prod.example.invalid';
    const shortPrefix = api.slice('/api'.length);
    const cfg = ['\uFEFF# Test config', 'stage=' + stage + '/gateway', 'DEV = ' + dev,
      'stage.prefix=' + customPrefix, 'prod=' + prod, 'prod.prefix=' + shortPrefix].join('\r\n');
    const read = (text, options = {}) => t.withStartupConfig(text, options, async relay => {
      const page = await requestLocal(relay.origin + '/');
      assert.equal(page.http, 200);
      const content = /<meta name="tbank-proxy-environments" content="([^"]+)">/.exec(page.data)[1];
      return JSON.parse(content.replaceAll('&quot;', '"'));
    });
    const configured = await read(cfg);
    assert.equal(configured.source, 'proxy.cfg');
    assert.deepEqual(configured.origins, { dev, stage, prod });
    assert.deepEqual(configured.paths, { dev: '', stage: '/gateway', prod: '' });
    assert.deepEqual(configured.prefixes, { dev: api, stage: customPrefix, prod: shortPrefix });
    assert.deepEqual(configured.statements, {
      dev: path.statement, stage: path.statement, prod: path.statement.slice('/api'.length),
    });
    assert.deepEqual((await read(cfg, { trusted: override })).origins, { custom: override });
    assert.deepEqual((await read(cfg, { mockOrigin: t.mock.origin })).origins, { mock: t.mock.origin });
    assert.deepEqual((await read(dev, { legacy: true })).origins, { custom: dev });
    await assert.rejects(read('dev=' + dev + '\nDEV=' + override), /Duplicate environment/);
    await assert.rejects(read('stage=' + t.mock.origin), /Set a trusted HTTPS origin/);
    await assert.rejects(read('stage=' + stage + '?qa=1'), /omit query parameters/);
  }),
  test('RELAY-03', 'Выбор окружения восстанавливает отдельный профиль и завершает прежний сеанс', async t => {
    const dev = 'https://dev.example.invalid:8443';
    const stage = 'https://stage.example.invalid';
    const prod = 'https://prod.example.invalid';
    const cfg = 'prod=' + prod + '\nstage=' + stage + '\ndev=' + dev + '/gateway';
    await t.withStartupConfig(cfg, {}, async relay => {
      const tab = await t.openTab(relay.origin + '/');
      const value = id => tab.evaluate(id => document.getElementById(id).value, id);
      try {
        await tab.click('#settings-link');
        await tab.has('#proxy-environment-help', 'из proxy.cfg');
        assert.deepEqual(await tab.evaluate(() => [...document.querySelector('#proxy-environment').options].map(option => option.text)),
          ['DEV (dev.example.invalid:8443)', 'STAGE (stage.example.invalid)', 'PROD (prod.example.invalid)']);
        assert.equal(await value('proxy-environment'), 'dev');
        assert.equal(await value('proxy'), dev + '/gateway');

        await tab.evaluate((proxy, accountId) => localStorage.setItem('nominal-accounts-settings',
          JSON.stringify({ proxy, prefix: '/api/v1/nominal-accounts', bankAccountId: accountId, accountNumber: '' })),
        dev + '/legacy', uuid(990));
        await tab.send('Page.navigate', { url: relay.origin + '/' });
        await tab.click('#settings-link');
        await tab.has('#proxy-environment-help', 'из proxy.cfg');
        assert.equal(await value('proxy'), dev + '/gateway');
        assert.equal(await value('bank-account-id'), uuid(990));

        await settings(tab, { account: '', accountId: uuid(991) });
        await sign(tab);
        await tab.has('#session-status', 'Токен подключён');

        await tab.click('#settings-link');
        await tab.fill('#proxy-environment', 'stage');
        await tab.has('#session-status', 'Войдите в окружение STAGE');
        await tab.has('#proxy-environment-help', 'Предпродакшен');
        assert.equal(await value('proxy'), stage);
        assert.equal(await value('bank-account-id'), '');
        assert.equal(await value('access-token'), '');
        await settings(tab, { account: '00000000000000000002', accountId: uuid(992) });

        await tab.fill('#proxy-environment', 'prod');
        await tab.has('#settings-environment', 'PROD');
        assert.equal(await value('proxy'), prod);
        assert.equal(await value('account-number'), '');
        await tab.fill('#proxy-environment', 'dev');
        assert.equal(await value('proxy'), dev + '/gateway');
        assert.equal(await value('bank-account-id'), uuid(991));
        await tab.fill('#proxy-environment', 'stage');
        assert.equal(await value('account-number'), '00000000000000000002');
        await tab.send('Page.navigate', { url: relay.origin + '/' });
        await tab.click('#settings-link');
        await tab.has('#proxy-environment-help', 'Предпродакшен');
        assert.equal(await value('proxy-environment'), 'stage');
        assert.equal(await value('bank-account-id'), uuid(992));

        const denied = await requestLocal(relay.origin + '/api/relay' + B, {
          headers: { 'X-TBank-Run': relay.run, 'X-TBank-Proxy-Origin': prod, 'X-TBank-Environment': 'dev', Authorization: 'Bearer ' + testToken },
        });
        assert.equal(denied.http, 403);
      } finally {
        await tab.closeTab();
      }
    });
  }),
];
