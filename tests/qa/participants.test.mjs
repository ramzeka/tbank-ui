
import { assert, path, test, until, uuid, demoAccount } from './harness.mjs';
import { u1, u2, u3, bankPath, list, open, entity, fields, org, sameKey, last, count, settings, sign, ready } from './flows.mjs';

const B = path.beneficiaries;
export const participants = [
  test('BEN-01', 'Список, пагинация, неправильный UUID и отсутствующая карточка', async t => {
    await list(t, 'beneficiaries');
    await t.has('#result', 'Атлас');
    await t.fill('#pagination select', '10');
    await until(async () => await count(t) === 10, '10 строк');
    await t.click('#pagination [data-page=next]');
    await until(() => t.calls('GET', B).some(call => call.url.includes('offset=10&limit=10')), 'вторая страница');
    await t.fill('#item-id', uuid(999998));
    await t.click('#detail-form button[type=submit]');
    await t.has('#beneficiary-status', '404');
    await t.fill('#item-id', 'invalid-uuid');
    await t.click('#detail-form button[type=submit]');
    await t.has('#beneficiary-status', 'UUID');
    assert.equal(t.calls('GET', B + '/invalid-uuid').length, 0);
  }),
  test('BEN-02', 'Создание, обязательный контакт, валидация поля, новый ключ для измененного тела и буквальный текст', async t => {
    await list(t, 'beneficiaries');
    await org(t, 'QA ООО', '0000000123', '');
    await t.click('#entity-save');
    await t.has('#entity-status', 'телефон или электронную почту');
    await entity(t, { email: 'qa@example.org' });
    await t.clickText('#entity-fields', 'Добавить адрес');
    await fields(t, '#entity-fields [data-collection=addresses]', { type: 'LEGAL_ENTITY_ADDRESS', address: 'Тестовый адрес' });
    t.before('POST', B, 422, { errorMessage: 'Проверьте организацию', errorDetails: { name: ['Измените наименование'] } }, { encode: true });
    const offset = t.calls('POST', B).length;
    const oldSize = t.mock.people.size;
    await t.click('#entity-save');
    await t.has('#entity-status', '422');
    assert.deepEqual(await t.evaluate(() => {
      const field = document.activeElement;
      return [field.name, field.getAttribute('aria-invalid'), Boolean(document.getElementById(field.getAttribute('aria-describedby')))];
    }), ['name', 'true', true]);
    const name = 'QA <b>Буквальный текст & макет</b>';
    await entity(t, { name });
    t.after('POST', B);
    await t.click('#entity-save');
    await t.has('#entity-status', '502');
    await t.click('#entity-save');
    await t.has('#beneficiary-feedback', 'Бенефициар создан');
    const [invalid, commit, retry] = t.calls('POST', B).slice(offset);
    assert.notEqual(invalid.key, commit.key);
    sameKey(commit, retry);
    assert.equal(t.mock.people.size, oldSize + 1);
    assert.equal(retry.response.beneficiaryId, commit.response.beneficiaryId);
    await t.has('#beneficiary-name', name);
    assert(await t.evaluate(() => !document.querySelector('#beneficiary-name b')));
    await list(t, 'beneficiaries');
    await open(t, 'beneficiaries', commit.response.beneficiaryId);
    await t.has('#beneficiary-name', name);
  }),
  test('BEN-03', 'Изменение физлица сохраняет ранее записанные документы и адреса', async t => {
    await list(t, 'beneficiaries');
    await open(t, 'beneficiaries', u3);
    const previous = t.mock.people.get(u3);
    await t.click('#beneficiary-edit');
    await entity(t, { email: 'qa-updated@example.org' });
    await t.click('#entity-save');
    await t.has('#beneficiary-data', 'qa-updated@example.org');
    const { body } = last(t, 'PUT', B + '/' + u3);
    assert.deepEqual(body.documents, previous.documents);
    assert.deepEqual(body.addresses, previous.addresses);
    assert.equal(t.mock.people.get(u3).email, 'qa-updated@example.org');
  }),
  test('BEN-04', 'Создание семи типов бенефициаров с адресами и документами', async t => {
    const types = [
      ['FL_RESIDENT', 'RU'], ['FL_NONRESIDENT', 'BY'], ['FL_NONRESIDENT', 'KZ'], ['UL_RESIDENT', ''],
      ['UL_NONRESIDENT', ''], ['IP_RESIDENT', 'RU'], ['IP_NONRESIDENT', 'KZ'], ['LITE_CONTACT', ''],
    ];
    for (const [type, country] of types) {
      await list(t, 'beneficiaries');
      await t.click('#beneficiary-create');
      await entity(t, { type });
      if (type !== 'LITE_CONTACT') await entity(t, { email: 'qa-type@example.org' });
      if (type === 'UL_RESIDENT') await entity(t, { inn: '0000000901', name: 'QA Резидент' });
      if (type === 'UL_NONRESIDENT') {
        await entity(t, { name: 'QA Нерезидент', registrationDate: '2024-05-01', registrationNumber: 'QA-101' });
        await t.click('#entity-save');
        await t.has('#entity-status', 'ИНН или КИО');
        await entity(t, { kio: 'QA-10' });
        await t.click('#entity-save');
        await t.has('#entity-status', 'юридический адрес');
        await addAddress(t, 'LEGAL_ENTITY_ADDRESS');
      }
      if (country) {
        await entity(t, { firstName: 'Ирина', lastName: 'Тестовая', birthDate: '1993-04-14', citizenship: country });
        if (type.startsWith('FL')) await entity(t, { isSelfEmployed: 'false' });
        else await entity(t, { registrationDate: '2024-08-16', inn: '000000000123' });
        await addAddress(t, 'REGISTRATION_ADDRESS');
        await t.clickText('#entity-fields', 'Добавить документ');
        const documents = '#entity-fields [data-collection=documents]';
        await fields(t, documents + ' .field-row:first-child', {
          number: '000010', date: '2020-02-02', organization: 'Демонстрационный орган',
          ...(country === 'RU' && { serial: '0000', division: '000-000' }),
        });
        if (country === 'KZ') {
          await t.click('#entity-save');
          await t.has('#entity-status', 'двух документов');
          await t.clickText('#entity-fields', 'Добавить документ');
          await fields(t, documents + ' .field-row:nth-child(2)', {
            documentType: 'VISA', number: '000009', date: '2020-02-02', expireDate: '2030-02-02',
          });
        }
      }
      await t.click('#entity-save');
      await t.has('#beneficiary-feedback', 'Бенефициар создан');
      const id = last(t, 'POST', B).response.beneficiaryId;
      assert.equal((await t.relay(B + '/' + id)).data.type, type);
    }
  }),
  test('BEN-05', 'После 502 закрытие и открытие формы сохраняют ключ и одну запись', async t => {
    await list(t, 'beneficiaries');
    const old = t.mock.people.size;
    const name = 'QA Повтор создания';
    await org(t, name);
    t.after('POST', B);
    await t.click('#entity-save');
    await t.has('#entity-status', 'Результат записи неизвестен');
    await t.click('#entity-cancel');
    await org(t, name);
    await t.click('#entity-save');
    await t.has('#beneficiary-feedback', 'Бенефициар создан');
    const [first, retry] = t.calls('POST', B).slice(-2);
    assert.equal(first.delivery, 502);
    sameKey(first, retry);
    assert.equal(first.response.beneficiaryId, retry.response.beneficiaryId);
    assert.equal(t.mock.people.size, old + 1);
  }),
  test('BEN-06', 'Ключи разделены по счету, токен и поля не попадают в журнал вкладки', async t => {
    await list(t, 'beneficiaries');
    const name = 'QA Разные контексты';
    await org(t, name);
    t.after('POST', B);
    await t.click('#entity-save');
    await t.has('#entity-status', '502');
    const first = last(t, 'POST', B);
    const slots = await t.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('nominal-accounts-pending:')));
    assert(slots.some(([key, value]) => /^[a-f0-9]{64}$/.test(key.split(':')[1]) && value === first.key));
    assert(!JSON.stringify(slots).includes(name));
    assert(!JSON.stringify(slots).includes('qa@example.org'));
    await t.click('#entity-cancel');
    await settings(t, { accountId: uuid(991) });
    await sign(t);
    await org(t, name);
    await t.click('#entity-save');
    await t.has('#beneficiary-feedback', 'Бенефициар создан');
    const another = last(t, 'POST', B);
    assert.equal(another.account, uuid(991));
    assert.notEqual(another.key, first.key);
    await ready(t, '#beneficiary-close');
    await settings(t);
    await sign(t);
    await org(t, name);
    await t.click('#entity-save');
    await t.has('#beneficiary-feedback', 'Бенефициар создан');
    const retry = last(t, 'POST', B);
    sameKey(first, retry);
    assert.equal(retry.response.beneficiaryId, first.response.beneficiaryId);
  }),
  test('BANK-01', 'CRUD, повтор записи, назначение основными, отмена и подтверждение удаления', async t => {
    await list(t, 'beneficiaries');
    await open(t, 'beneficiaries', u1);
    await t.click('#bank-toggle');
    await t.clickText('#bank-list', demoAccount);
    await t.wait('#bank-record-' + uuid(501));
    await t.click('#bank-create');
    await entity(t, {
      bankName: 'QA Банк', bik: '000000012', accountNumber: '00000000000000000421',
      corrAccountNumber: '00000000000000000422', kpp: '000000001', isDefault: 'false',
    });
    const route = bankPath(u1);
    const accounts = t.mock.accounts.get(u1);
    const old = accounts.size;
    t.after('POST', route);
    await t.click('#entity-save');
    await t.has('#entity-status', '502');
    await t.click('#entity-save');
    await t.has('#bank-status', 'добавлены');
    const [first, retry] = t.calls('POST', route).slice(-2);
    sameKey(first, retry);
    const id = first.response.bankDetailsId;
    assert.equal(retry.response.bankDetailsId, id);
    assert.equal(accounts.size, old + 1);
    const detail = '#bank-record-' + id;
    await t.clickText(detail, 'Редактировать');
    await entity(t, { bankName: 'QA Банк обновлён' });
    await t.click('#entity-save');
    await t.has(detail, 'QA Банк обновлён');
    await t.clickText(detail, 'Сделать основными');
    await t.has('#bank-status', 'Основные реквизиты изменены');
    await t.wait(detail);
    assert.equal(accounts.get(id).isDefault, true);
    assert.equal([...accounts.values()].filter(bank => bank.isDefault).length, 1);
    t.cancelConfirm();
    await t.clickText(detail, 'Удалить');
    assert.equal(t.calls('DELETE', route + '/' + id).length, 0);
    await t.clickText(detail, 'Удалить');
    await t.has('#bank-status', 'удалены');
    assert(!accounts.has(id));
    assert.equal((await t.relay(route + '/' + id)).status, 404);
  }),
  test('BANK-02', 'Реквизиты на второй странице и проверка несовпадения ID карточки', async t => {
    const accounts = t.mock.accounts.get(u2);
    for (let index = 1; index <= 51; index++) {
      const bankDetailsId = uuid(7100 + index);
      const accountNumber = String(4000 + index).padStart(20, '0');
      accounts.set(bankDetailsId, { type: 'PAYMENT_DETAILS', bankDetailsId, accountNumber, bankName: 'QA Реквизиты ' + index });
    }
    try {
      await list(t, 'beneficiaries');
      await open(t, 'beneficiaries', u2);
      await t.click('#bank-toggle');
      await t.has('#bank-list', 'QA Реквизиты 51');
      assert(t.calls('GET', bankPath(u2)).some(call => call.url.includes('offset=50')));
      const id = uuid(7151);
      t.before('GET', bankPath(u2) + '/' + id, 200, { ...accounts.get(id), bankDetailsId: uuid(7150) });
      await t.clickText('#bank-list', accounts.get(id).accountNumber);
      await t.has('#bank-status', 'данные других реквизитов');
      await t.gone('#bank-record-' + id);
      await t.clickText('#bank-list', accounts.get(id).accountNumber);
      await t.has('#bank-record-' + id, 'QA Реквизиты 51');
    } finally {
      accounts.clear();
    }
  }),
  test('READ-01', 'Восемь результатов скоринга', async t => {
    for (const [id, code] of [[1, 'SUCCEEDED'], [2, 'FAILED'], [3, 'IN_BLACKLIST'], [5, 'IN_PROGRESS'],
      [6, 'DEMO_NEW_STATUS'], [7, '503'], [8, 'INVALID_PASSPORT'], [10, '']]) {
      await list(t, 'beneficiaries');
      await open(t, 'beneficiaries', uuid(id));
      const start = t.calls('GET', path.scoring).length;
      await t.click('#scoring-check');
      const request = await until(() => t.calls('GET', path.scoring)[start], 'ответ скоринга');
      if (code === '503') await t.has('#scoring-status', code);
      else if (code) {
        assert(JSON.stringify(request.response).includes(code));
        await until(() => t.text('#scoring-result'), 'результат доступен');
      } else {
        assert.deepEqual(request.response.results, []);
        await until(() => t.text('#scoring-status'), 'пустой скоринг');
      }
    }
  }),
  test('READ-02', 'Остатки, холды и независимые страницы переводов', async t => {
    await list(t, 'beneficiaries');
    await open(t, 'beneficiaries', u1);
    await t.click('#funds-toggle');
    await t.has('#balance-table', demoAccount);
    await t.has('#holds-table', demoAccount);
    await t.click('#balance-load');
    for (const route of [path.balances, path.holds]) {
      await until(() => t.calls('GET', route).filter(call => call.url.includes('beneficiaryId=' + u1)).length >= 2, 'обновление ' + route);
      assert(last(t, 'GET', route).url.includes('accountNumber=' + demoAccount));
    }
    await t.click('#beneficiary-transfers-toggle');
    await t.clickText('#beneficiary-transfer-lists', 'Входящие');
    await t.clickText('#beneficiary-transfer-lists', 'Исходящие');
    await t.click('#beneficiary-transfer-lists > section:first-child [data-page=next]');
    await until(() => t.calls('GET', path.transfers).some(call => {
      const query = new URL(call.url, t.origin).searchParams;
      return query.get('toBeneficiaryId') === u1 && Number(query.get('offset')) > 0;
    }), 'следующая страница входящих');
    assert(t.calls('GET', path.transfers).some(call => call.url.includes('fromBeneficiaryId=' + u1) && call.url.includes('offset=0')));
  }),
];

async function addAddress(t, type) {
  await t.clickText('#entity-fields', 'Добавить адрес');
  await fields(t, '#entity-fields [data-collection=addresses]', { type, address: 'Демонстрационный город, ул. Тестов 22' });
}
