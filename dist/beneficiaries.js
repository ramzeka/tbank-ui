import { createEditor, showFieldErrors } from './entity-editor.js';
import { appendCopyId } from './copy-id.js';
import { fieldCaption, insertExpandedRow, isIdField, recordDetails, recordField, tableCell, tableHeaders } from './record-details.js';
import {
  addressFields, addressTypes, bankFields, bankTypes, beneficiaryFields, beneficiaryTypes, documentFields, documentTypes,
} from './beneficiary-schema.js';

const $ = (id) => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const collection = '/beneficiaries';
const bankLimit = 50;
const balanceLimit = 50;
export const scoringPath = collection + '/scoring';

export function beneficiaryName(record, fallback = beneficiaryTypes[record.type] || 'Бенефициар') {
  return String(record.name ?? '').trim() || [record.lastName, record.firstName, record.middleName]
    .map(value => String(value ?? '').trim()).filter(Boolean).join(' ') || fallback;
}

function decodeEnvelope(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!/^[{["]/.test(text)) return value;
  try { return JSON.parse(text); } catch { return value; }
}

const listKeys = ['results', 'result', 'items', 'content', 'records', 'rows', 'entries', 'list', 'data'];
const envelopeKeys = ['data', 'result', 'body', 'payload', 'response', 'value', 'resultData', 'responseBody'];
const normalizeKey = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

function totalRecords(value) {
  const candidates = [value, value.pagination, value.page, value.meta].filter(Boolean);
  for (const entry of candidates) {
    const count = entry.total ?? entry.totalCount ?? entry.totalElements ?? entry.totalItems;
    const total = typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : count;
    if (Number.isSafeInteger(total) && total >= 0) return total;
  }
  return undefined;
}

export function listPage(data, keys, recordKeys) {
  const preferred = new Set([...listKeys, ...keys].map(normalizeKey));
  const candidates = [];
  function visit(input, level, total, priority) {
    if (input == null || level > 8) return;
    const value = decodeEnvelope(input);
    if (value !== input) return visit(value, level + 1, total, priority);
    if (Array.isArray(value)) {
      const objects = value.every((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (!objects) return;
      const recognized = value.some((item) => recordKeys.some((key) => Object.hasOwn(item, key)));
      if (priority || recognized) candidates.push({ rows: value, total, rank: recognized ? 3 + priority : priority });
      return;
    }
    if (typeof value !== 'object') return;
    const count = totalRecords(value) ?? total;
    for (const [key, child] of Object.entries(value)) {
      const rank = keys.some((name) => normalizeKey(name) === normalizeKey(key)) ? 2 : preferred.has(normalizeKey(key)) ? 1 : 0;
      if (rank || (child && typeof child === 'object') || envelopeKeys.some((name) => normalizeKey(name) === normalizeKey(key))) {
        visit(child, level + 1, count, rank);
      }
    }
  }

  visit(data, 0, undefined, 2);
  const bestRank = Math.max(...candidates.map((entry) => entry.rank));
  const matched = candidates.filter((entry) => entry.rank === bestRank);
  if (matched.length === 1) return { rows: matched[0].rows, total: matched[0].total };
  const root = decodeEnvelope(data);
  const shape = root && typeof root === 'object'
    ? Object.keys(root).slice(0, 8).map((key) => key.slice(0, 40)).join(', ')
    : typeof root === 'string' ? 'текст' : 'пустое тело';
  const message = matched.length ? 'В ответе прокси несколько списков.' : 'Не удалось распознать список в ответе прокси.';
  throw new Error(message + ' Верхний уровень: ' + (shape || 'пустой объект') + '.');
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function status(id, message, state = 'idle') {
  $(id).textContent = message;
  $(id).dataset.state = state;
}

function optionalRecord(data, key) {
  const fields = key === 'beneficiary' ? ['beneficiaryId', 'id', 'type', 'firstName', 'name'] : ['bankDetailsId', 'id', 'type', 'accountNumber', 'cardId'];
  function unwrap(input, depth) {
    if (depth > 8) return null;
    const value = decodeEnvelope(input);
    if (value !== input) return unwrap(value, depth + 1);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (fields.some((field) => Object.hasOwn(value, field))) return value;
    for (const name of [key, ...envelopeKeys]) {
      const record = unwrap(value[name], depth + 1);
      if (record) return record;
    }
    return null;
  }
  return unwrap(data, 0);
}

function recordObject(data, key) {
  const record = optionalRecord(data, key);
  if (!record) throw new Error('Не удалось распознать карточку в ответе прокси.');
  return record;
}

export async function fetchBeneficiary(request, id, signal) {
  const data = await request(collection + '/' + id, { signal });
  const record = recordObject(data, 'beneficiary');
  const returnedId = record.beneficiaryId ?? record.id;
  if (returnedId != null && String(returnedId).toLowerCase() !== id.toLowerCase()) {
    throw new Error('Прокси вернул карточку другого бенефициара.');
  }
  return record;
}

export function setDisclosure(toggle, content, expanded) {
  content.hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.querySelector('.disclosure-label').textContent = expanded ? 'Свернуть' : 'Развернуть';
}

function textValue(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

function detailFields(record, fields, typeLabel) {
  const grid = element('dl', '', 'record-fields standalone-fields');
  for (const { key, label } of fields) {
    const value = key === 'type' && typeLabel ? typeLabel : record[key];
    if (value == null || value === '') continue;
    grid.append(recordField(key, label, textValue(value)));
  }
  return grid;
}

function itemGroup(title, items, types, fieldsFor) {
  if (!Array.isArray(items) || !items.length) return null;
  const group = element('details', '', 'raw-details');
  group.append(element('summary', title + ' (' + items.length + ')'));
  for (const item of items) {
    group.append(detailFields(item, [{ key: 'type', label: 'Тип' }, ...fieldsFor(item)], types[item.type]));
  }
  return group;
}

function button(text, action, className = 'secondary') {
  const control = element('button', text, className);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}


const balanceLabels = new Map(Object.entries({
  accountNumber: 'Номинальный счёт', virtualAccountNumber: 'Виртуальный счёт',
  beneficiaryId: 'ID бенефициара', virtualAccountId: 'ID виртуального счёта',
  balance: 'Баланс', amount: 'Сумма', currency: 'Валюта', availableAmount: 'Доступно',
  availableBalance: 'Доступный остаток', heldAmount: 'Зарезервировано',
  holdId: 'ID холда', holdAmount: 'Сумма холда', dealId: 'ID сделки', stepId: 'ID этапа',
  status: 'Статус', type: 'Тип', createdAt: 'Дата создания',
}));

function balanceValue(value) {
  if (Array.isArray(value)) return value.map(balanceValue).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => (balanceLabels.get(key) ?? key) + ' — ' + balanceValue(item)).join(' · ');
  }
  return textValue(value);
}

export async function fetchBalancePage(request, beneficiaryId, offset, signal, kind = 'balances') {
  const query = { beneficiaryId, offset, limit: balanceLimit };
  const data = await request('/virtual-accounts/' + kind, { query, signal });
  signal.throwIfAborted();
  const { rows, total } = listPage(data, [kind], ['beneficiaryId', 'balance', 'amount', 'holdAmount', 'holdId', 'accountNumber']);
  if (rows.some(row => row.beneficiaryId != null && String(row.beneficiaryId).toLowerCase() !== beneficiaryId.toLowerCase())) {
    throw new Error('В ответе есть записи другого бенефициара. Проверьте фильтр прокси.');
  }
  const hasMore = rows.length > 0 && (total == null ? rows.length === balanceLimit : offset + rows.length < total);
  return { rows, hasMore };
}

export function balanceTable(rows, { hideBeneficiaryId = false } = {}) {
  const table = element('table');
  const keys = new Set(rows.flatMap(row => Object.keys(row)));
  if (hideBeneficiaryId && keys.size > 1) keys.delete('beneficiaryId');
  const columns = [];
  for (const key of ['balance', 'availableBalance', 'availableAmount', 'heldAmount', 'amount', 'holdAmount', 'currency', 'accountNumber']) {
    if (keys.delete(key)) columns.push(key);
  }
  columns.push(...keys);
  tableHeaders(table, columns.map(key => balanceLabels.get(key) ?? key));
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const key of columns) {
      const cell = tableCell(tr, balanceValue(row[key]));
      if (isIdField(key)) {
        cell.className = 'record-id';
        appendCopyId(cell, row[key], balanceLabels.get(key) ?? key);
      }
    }
  }
  return table;
}

const scoringStatuses = new Map([
  ['SUCCEEDED', { title: 'Проверка пройдена', state: 'success' }],
  ['FAILED', { title: 'Проверка не пройдена', state: 'error' }],
  ['IN_PROGRESS', { title: 'Проверка выполняется', state: 'loading' }],
  ['PENDING', { title: 'Проверка ожидается', state: 'loading' }],
]);
const scoringCodes = new Map([
  ['INVALID_INN', 'Не подтверждены паспортные данные'],
  ['INVALID_PASSPORT', 'Паспорт недействителен'],
  ['IN_BLACKLIST', 'Бенефициар найден в чёрных списках'],
  ['UL_CLOSED', 'Организация закрыта'],
  ['UL_NOT_FOUND', 'Бенефициар не найден в ЕГРЮЛ'],
]);
function scoringIssues(title, state, codes) {
  if (!Array.isArray(codes)) return null;
  const list = element('ul');
  for (const code of codes) {
    if (typeof code !== 'string' || !code.trim()) continue;
    const item = element('li');
    const description = scoringCodes.get(code);
    if (description) item.append(element('span', description));
    item.append(element('code', code));
    list.append(item);
  }
  if (!list.childElementCount) return null;
  const group = element('div', '', 'notice-issues');
  group.dataset.state = state;
  const heading = element('h4');
  heading.append(fieldCaption(title));
  group.append(heading, list);
  return group;
}

function scoringDetails(result) {
  let code = typeof result.status === 'string' ? result.status.trim() : '';
  if (code === 'PASSED' || (!code && result.passed === true)) code = 'SUCCEEDED';
  if (!code && result.passed === false) code = 'FAILED';
  const errors = scoringIssues('Ошибки', 'error', result.errors);
  const warnings = scoringIssues('Предупреждения', 'warning', result.warnings);
  const knownStatus = scoringStatuses.get(code);
  const appearance = code === 'SUCCEEDED' && warnings
    ? { title: 'Проверка пройдена с предупреждениями', state: 'warning' }
    : knownStatus ?? { title: code ? 'Статус проверки неизвестен' : 'Статус проверки не указан', state: 'unknown' };

  const card = element('div', '', 'notice');
  card.dataset.state = appearance.state;
  const summary = element('div', '', 'notice-summary');
  summary.append(element('strong', appearance.title));
  if (!knownStatus && code) summary.append(element('code', code));
  card.append(summary);
  if (errors || warnings) {
    const details = element('div', '', 'notice-details');
    if (errors) details.append(errors);
    if (warnings) details.append(warnings);
    card.append(details);
  }
  return card;
}

export function initBeneficiaries(request, refreshList, transfers) {
  let enabled = false;
  let active;
  let writing = false;
  let beneficiary;
  let returnFocus;
  let editor;
  let balanceOffset = 0;
  let moreBalances = false;
  let holdsOffset = 0;
  let moreHolds = false;
  const bankRows = new Map();
  let expandedBank;
  const disclosure = (key, load) => ({ toggle: $(key + '-toggle'), content: $(key + '-content'), load, loaded: false });
  const bankBlock = disclosure('bank', () => run('bank-availability', loadBank));
  const fundsBlock = disclosure('funds', () => run('balance-status', loadVirtualAccounts));
  const transferBlock = disclosure('beneficiary-transfers');
  const blocks = [bankBlock, fundsBlock, transferBlock];

  function loadOpenedBlock() {
    if (!enabled || !beneficiary || active || editor) return;
    const block = blocks.find(block => block.load && !block.content.hidden && !block.loaded);
    if (!block) return;
    block.loaded = true;
    block.load();
  }

  function controls() {
    const busy = !enabled || Boolean(active);
    for (const node of document.querySelectorAll('[data-beneficiary-action], #bank-list button')) node.disabled = busy;
    $('balance-prev').disabled = busy || !balanceOffset;
    $('balance-next').disabled = busy || !moreBalances;
    $('holds-prev').disabled = busy || !holdsOffset;
    $('holds-next').disabled = busy || !moreHolds;
    $('entity-fields').disabled = busy;
    $('entity-save').disabled = busy;
    $('entity-cancel').disabled = writing;
    $('beneficiary-close').disabled = writing;
    $('beneficiary-edit').disabled ||= !Object.hasOwn(beneficiaryFields, beneficiary?.type);
  }

  function showScreen() {
    $('entity-editor').hidden = !editor;
    $('list-panel').hidden = Boolean(editor || beneficiary);
    $('beneficiary-view').hidden = Boolean(editor || !beneficiary);
    if (enabled && beneficiary && !editor) transfers.setBeneficiary(beneficiary);
    controls();
  }

  function resetEditor() {
    editor = undefined;
    $('entity-fields').replaceChildren();
    $('entity-title').textContent = '';
    $('entity-owner').textContent = '';
    status('entity-status', '');
    showScreen();
    loadOpenedBlock();
  }

  function leaveEditor() {
    if (writing) return false;
    if (!editor) return true;
    if (editor.dirty() && !confirm('Выйти без сохранения изменений?')) return false;
    const target = editor.trigger;
    if (enabled) resetEditor();
    else close();
    if (target?.isConnected) target.focus();
    return true;
  }

  function clearScoring() {
    $('scoring-result').replaceChildren();
    status('scoring-status', '');
  }

  function close() {
    active?.abort();
    active = undefined;
    writing = false;
    beneficiary = undefined;
    returnFocus = undefined;
    transfers.reset();
    for (const block of blocks) {
      block.loaded = false;
      setDisclosure(block.toggle, block.content, false);
    }
    balanceOffset = 0;
    moreBalances = false;
    $('balance-pages').hidden = true;
    $('balance-table').replaceChildren();
    status('balance-status', '');
    holdsOffset = 0;
    moreHolds = false;
    $('holds-pages').hidden = true;
    $('holds-table').replaceChildren();
    status('holds-status', '');
    clearScoring();
    closeBank();
    bankRows.clear();
    $('bank-retry').hidden = true;
    $('beneficiary-name').textContent = 'Карточка бенефициара';
    $('beneficiary-type').textContent = '';
    for (const id of ['beneficiary-data', 'bank-list']) $(id).replaceChildren();
    for (const id of ['beneficiary-status','beneficiary-feedback','bank-status','bank-availability']) status(id, '');
    resetEditor();
  }

  function setEnabled(value) {
    const wasEnabled = enabled;
    enabled = value;
    if (wasEnabled && !enabled) close();
    controls();
  }

  async function run(statusId, action, mutation = false) {
    if (!enabled || active) return;
    const controller = new AbortController();
    active = controller;
    writing = mutation;
    status(statusId, mutation ? 'Отправляем запрос…' : 'Загружаем данные…', 'loading');
    controls();
    let invalidField;
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        status(statusId, error.message, 'error');
        if (editor) invalidField = showFieldErrors(error.details);
      }
    } finally {
      if (active === controller) {
        active = undefined;
        writing = false;
        controls();
        invalidField?.focus();
        loadOpenedBlock();
      }
    }
  }

  function startEditor(kind, record, trigger) {
    const label = beneficiary ? beneficiaryName(beneficiary) : '';
    editor = createEditor(kind, record, { label, type: beneficiary?.type });
    editor.trigger = trigger;
    status('entity-status', '');
    showScreen();
    $('entity-title').focus();
  }

  function displayBeneficiary(record) {
    beneficiary = record;
    $('beneficiary-name').textContent = beneficiaryName(record);
    $('beneficiary-type').textContent = beneficiaryTypes[record.type] ?? record.type ?? '';
    const fields = [
      { key: 'beneficiaryId', label: 'ID бенефициара' }, ...(beneficiaryFields[record.type] ?? []),
    ];
    const values = Object.fromEntries(fields.flatMap(({ key }) =>
      record[key] == null || record[key] === '' ? [] : [[key, textValue(record[key])]],
    ));
    const card = element('div', '', 'record-card');
    const groups = [
      { summary: true, keys: ['beneficiaryId', 'inn', 'registrationDate', 'birthDate'] },
      { title: 'Данные бенефициара' },
    ];
    card.append(recordDetails(values, fields.map(({ key, label }) => [key, label]), 'beneficiaryId', groups));
    $('beneficiary-data').replaceChildren(card);
    const addresses = itemGroup('Адреса', record.addresses, addressTypes, () => addressFields.filter(f => f.key !== 'type'));
    const documents = itemGroup('Документы', record.documents, documentTypes, item => documentFields[item.type] ?? []);
    if (addresses) $('beneficiary-data').append(addresses);
    if (documents) $('beneficiary-data').append(documents);
    $('item-id').value = record.beneficiaryId;
    showScreen();
    $('beneficiary-name').focus();
  }

  const bankPath = () => collection + '/' + beneficiary.beneficiaryId + '/bank-details';

  function closeBank() {
    if (!expandedBank) return;
    expandedBank.trigger.setAttribute('aria-expanded', 'false');
    expandedBank.trigger.removeAttribute('aria-controls');
    expandedBank.row.remove();
    expandedBank = undefined;
  }

  function displayBank(record) {
    const id = record.bankDetailsId.toLowerCase();
    const target = bankRows.get(id);
    if (!target) return;
    closeBank();
    const details = element('section', '', 'bank-detail');
    details.id = 'bank-record-' + id;
    const title = element('h3', 'Реквизиты · ' + (bankTypes[record.type] ?? record.type));
    title.id = details.id + '-title';
    title.tabIndex = -1;
    details.setAttribute('aria-labelledby', title.id);
    const actions = element('div', '', 'actions');
    actions.append(button('Редактировать', event => startEditor('bank', record, event.currentTarget)));
    if (!record.isDefault) actions.append(button('Сделать основными', () => changeBank(record, false)));
    actions.append(button('Удалить', () => changeBank(record, true), 'danger'));
    details.append(title, detailFields(record, [
      { key: 'bankDetailsId', label: 'ID реквизитов' }, ...bankFields.PAYMENT_DETAILS,
    ]), actions);
    const row = insertExpandedRow(target.row, details);
    target.trigger.setAttribute('aria-expanded', 'true');
    target.trigger.setAttribute('aria-controls', details.id);
    expandedBank = { id, row, trigger: target.trigger };
    controls();
    title.focus();
  }

  function openBank(id) {
    if (!uuid.test(id) || active) return;
    const isOpen = expandedBank?.id === id.toLowerCase();
    closeBank();
    if (isOpen) {
      status('bank-status', '');
      return;
    }
    return run('bank-status', async signal => {
      const record = recordObject(await request(bankPath() + '/' + id, { signal }), 'bankDetails');
      if (record.type !== 'PAYMENT_DETAILS') throw new Error('Для этого типа реквизитов операции недоступны.');
      const returnedId = record.bankDetailsId ?? record.id;
      if (returnedId != null && String(returnedId).toLowerCase() !== id.toLowerCase()) {
        throw new Error('Прокси вернул данные других реквизитов.');
      }
      displayBank({ ...record, bankDetailsId: id });
      status('bank-status', '');
    });
  }

  function changeBank(record, deleting) {
    if (writing || active || record.type !== 'PAYMENT_DETAILS' || !uuid.test(record.bankDetailsId)) return;
    const label = beneficiaryName(beneficiary) + ' · Банковский счёт · ' +
      (record.bankName || '') + ' · …' + (record.accountNumber?.slice(-4) || record.bankDetailsId);
    if (!confirm((deleting ? 'Удалить реквизиты?' : 'Сделать реквизиты основными?') + '\n' + label)) return;
    run('bank-status', async signal => {
      const path = bankPath() + '/' + record.bankDetailsId;
      await request(deleting ? path : path + '/set-default', { method: deleting ? 'DELETE' : 'POST', signal });
      status('bank-status', deleting ? 'Реквизиты удалены.' : 'Основные реквизиты изменены.', 'success');
      await loadBank(signal);
      const saved = bankRows.get(record.bankDetailsId.toLowerCase())?.record;
      if (!deleting && saved) displayBank({ ...record, ...saved });
      else if (!signal.aborted) $('bank-title').focus();
    }, true);
  }

  function bankTable(records) {
    const table = element('table');
    tableHeaders(table, ['Тип', 'Счёт или получатель', 'Банк', 'По умолчанию']);
    const body = table.createTBody();
    for (const record of records) {
      const row = body.insertRow();
      tableCell(row, bankTypes[record.type] ?? record.type);
      const label = record.accountNumber || record.name || record.bankDetailsId || '—';
      const supported = record.type === 'PAYMENT_DETAILS' && uuid.test(record.bankDetailsId);
      if (supported) {
        const trigger = button(label, () => openBank(record.bankDetailsId), 'link');
        trigger.setAttribute('aria-expanded', 'false');
        tableCell(row, trigger);
        bankRows.set(record.bankDetailsId.toLowerCase(), { row, trigger, record });
      } else tableCell(row);
      tableCell(row, record.bankName || null);
      tableCell(row, record.isDefault ? 'Да' : null);
    }
    return table;
  }
  async function loadBank(signal) {
    let offset = 0;
    const records = [];
    const ids = new Set();
    closeBank();
    bankRows.clear();
    $('bank-retry').hidden = true;
    $('bank-list').replaceChildren();
    status('bank-availability', 'Загружаем реквизиты…', 'loading');
    try {
      for (;;) {
        const data = await request(bankPath(), { query: { offset, limit: bankLimit }, signal });
        const { rows, total } = listPage(data, ['bankDetails', 'requisites'], ['bankDetailsId', 'accountNumber', 'cardId']);
        for (const row of rows) {
          const id = row.bankDetailsId ?? row.id;
          if (id && ids.has(id)) throw new Error('Прокси повторил страницу реквизитов.');
          if (id) ids.add(id);
          records.push({ ...row, bankDetailsId: id });
        }
        offset += rows.length;
        if (!rows.length || (total === undefined ? rows.length < bankLimit : offset >= total)) break;
      }
      status('bank-availability', records.length ? '' : 'У бенефициара нет реквизитов.');
      if (records.length) $('bank-list').replaceChildren(bankTable(records));
      return records;
    } catch (error) {
      if (!signal.aborted) {
        status('bank-availability', error.message, 'error');
        $('bank-retry').hidden = false;
      }
    }
  }


  async function loadBalances(offset, signal) {
    const { rows, hasMore } = await fetchBalancePage(request, beneficiary.beneficiaryId, offset, signal);
    balanceOffset = offset;
    moreBalances = hasMore;
    $('balance-table').replaceChildren(...(rows.length ? [balanceTable(rows, { hideBeneficiaryId: true })] : []));
    $('balance-pages').hidden = !(offset || moreBalances);
    const message = offset ? 'Больше записей нет.' : 'Данных об остатках нет.';
    status('balance-status', rows.length ? '' : message);
  }

  function refreshBalances(offset) {
    return run('balance-status', signal => loadBalances(offset, signal));
  }

  async function loadHolds(offset, signal) {
    const { rows, hasMore } = await fetchBalancePage(request, beneficiary.beneficiaryId, offset, signal, 'holds');
    holdsOffset = offset;
    moreHolds = hasMore;
    $('holds-table').replaceChildren(...(rows.length ? [balanceTable(rows, { hideBeneficiaryId: true })] : []));
    $('holds-pages').hidden = !(offset || moreHolds);
    status('holds-status', rows.length ? '' : offset ? 'Больше записей нет.' : 'Холдов нет.');
  }

  function loadVirtualAccounts(signal) {
    status('balance-status', 'Загружаем баланс…', 'loading');
    status('holds-status', 'Загружаем холды…', 'loading');
    return Promise.all([
      loadBalances(0, signal).catch(error => {
        if (!signal.aborted) status('balance-status', error.message, 'error');
      }),
      loadHolds(0, signal).catch(error => {
        if (!signal.aborted) status('holds-status', error.message, 'error');
      }),
    ]);
  }

  async function loadScoring(signal) {
    $('scoring-result').replaceChildren();
    const { beneficiaryId } = beneficiary;
    const data = await request(scoringPath, { query: { beneficiaryId }, signal });
    signal.throwIfAborted();
    const { rows } = listPage(data, ['scoringResults'], ['beneficiaryId', 'status', 'passed']);
    if (rows.some(row => row.beneficiaryId != null && String(row.beneficiaryId).toLowerCase() !== beneficiaryId.toLowerCase())) {
      throw new Error('Прокси вернул результат проверки другого бенефициара.');
    }
    $('scoring-result').replaceChildren(...rows.map(scoringDetails));
    status('scoring-status', rows.length ? '' : 'Результат проверки пока недоступен.');
  }

  function open(id, trigger) {
    if (!enabled || writing || editor) return;
    close();
    return run('beneficiary-status', async signal => {
      id = id.trim();
      if (!uuid.test(id)) throw new Error('Введите ID бенефициара в формате UUID.');
      const record = await fetchBeneficiary(request, id, signal);
      returnFocus = trigger;
      displayBeneficiary({ ...record, beneficiaryId: id });
      status('beneficiary-status', '');
    });
  }

  async function save(signal) {
    const { isBank, record } = editor;
    showFieldErrors();
    const body = editor.read();
    const root = isBank ? bankPath() : collection;
    const id = isBank ? record?.bankDetailsId : record?.beneficiaryId;
    const data = await request(id ? root + '/' + id : root, {
      method: id ? 'PUT' : 'POST', body, idempotent: !id, signal,
    });
    // The mutation succeeded. A failed follow-up read must not offer another creation.
    resetEditor();
    if (isBank) {
      const result = data ? optionalRecord(data, 'bankDetails') : null;
      const savedId = result?.bankDetailsId ?? result?.id ?? id;
      status('bank-status', record ? 'Реквизиты обновлены.' : 'Реквизиты добавлены.', 'success');
      await loadBank(signal);
      signal.throwIfAborted();
      const saved = uuid.test(savedId) && bankRows.get(savedId.toLowerCase())?.record;
      if (saved) displayBank({ ...body, ...result, ...saved });
      return;
    }
    const result = optionalRecord(data, 'beneficiary');
    const savedId = result?.beneficiaryId ?? result?.id ?? id;
    refreshList();
    if (!uuid.test(savedId)) {
      status('beneficiary-status', 'Банк подтвердил создание, но ответ не содержит ID. Найдите запись в обновлённом списке.', 'success');
      return;
    }
    clearScoring();
    displayBeneficiary({ ...body, ...result, beneficiaryId: savedId });
    const message = record ? 'Данные бенефициара обновлены.' : 'Бенефициар создан.';
    status('beneficiary-feedback', message, 'success');
    try {
      const full = await fetchBeneficiary(request, savedId, signal);
      displayBeneficiary({ ...full, beneficiaryId: savedId });
    } catch (error) {
      signal.throwIfAborted();
      if (!enabled) return;
      status('beneficiary-feedback', message + ' Не удалось обновить карточку. ' + error.message, 'error');
    }
    await Promise.all([
      bankBlock.content.hidden ? undefined : loadBank(signal),
      fundsBlock.content.hidden ? undefined : loadVirtualAccounts(signal),
    ]);
  }

  $('entity-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editor) run('entity-status', save, true);
  });
  for (const block of blocks) block.toggle.addEventListener('click', () => {
    setDisclosure(block.toggle, block.content, block.content.hidden);
    loadOpenedBlock();
  });
  $('entity-cancel').addEventListener('click', leaveEditor);
  $('beneficiary-create').addEventListener('click', event => startEditor('beneficiary', null, event.currentTarget));
  $('beneficiary-edit').addEventListener('click', event => startEditor('beneficiary', beneficiary, event.currentTarget));
  $('balance-load').addEventListener('click', () => run('balance-status', loadVirtualAccounts));
  $('balance-prev').addEventListener('click', () => refreshBalances(Math.max(0, balanceOffset - balanceLimit)));
  $('balance-next').addEventListener('click', () => refreshBalances(balanceOffset + balanceLimit));
  $('holds-prev').addEventListener('click', () => run('holds-status', signal => loadHolds(Math.max(0, holdsOffset - balanceLimit), signal)));
  $('holds-next').addEventListener('click', () => run('holds-status', signal => loadHolds(holdsOffset + balanceLimit, signal)));
  $('scoring-check').addEventListener('click', () => run('scoring-status', loadScoring));
  $('bank-create').addEventListener('click', event => startEditor('bank', null, event.currentTarget));
  $('bank-retry').addEventListener('click', () => run('bank-availability', loadBank));
  $('beneficiary-close').addEventListener('click', () => {
    const target = returnFocus?.isConnected ? returnFocus : $('results-title');
    close();
    target.focus();
  });
  window.addEventListener('beforeunload', event => {
    if (writing || editor?.dirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  return {
    close, open, setEnabled, leaveEditor,
    get editing() { return Boolean(editor); },
  };
}
