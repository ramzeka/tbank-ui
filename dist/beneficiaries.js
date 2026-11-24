import { createEditor, showFieldErrors } from './entity-editor.js';
import {
  addressFields, addressTypes, bankFields, bankTypes, beneficiaryFields, beneficiaryTypes, documentFields, documentTypes,
} from './beneficiary-schema.js';

const $ = (id) => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const collection = '/beneficiaries';
const bankLimit = 50;
const balanceLimit = 50;

export function beneficiaryName(record) {
  return record.name || [record.lastName, record.firstName, record.middleName].filter(Boolean).join(' ') ||
    beneficiaryTypes[record.type] || 'Бенефициар';
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

function textValue(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

function detailFields(record, fields, typeLabel) {
  const grid = element('dl', '', 'detail-grid');
  for (const { key, label } of fields) {
    const value = key === 'type' && typeLabel ? typeLabel : record[key];
    if (value == null || value === '') continue;
    grid.append(element('dt', label), element('dd', textValue(value)));
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
}));

function balanceValue(value) {
  if (Array.isArray(value)) return value.map(balanceValue).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => (balanceLabels.get(key) ?? key) + ' — ' + balanceValue(item)).join(' · ');
  }
  return textValue(value);
}

export async function fetchBalancePage(request, beneficiaryId, offset, signal) {
  const query = { beneficiaryId, offset, limit: balanceLimit };
  const data = await request('/virtual-accounts/balances', { query, signal });
  signal.throwIfAborted();
  const { rows, total } = listPage(data, ['balances'], ['beneficiaryId', 'balance', 'amount', 'accountNumber']);
  if (rows.some(row => row.beneficiaryId != null && String(row.beneficiaryId).toLowerCase() !== beneficiaryId.toLowerCase())) {
    throw new Error('В ответе есть остатки другого бенефициара. Проверьте фильтр прокси.');
  }
  const hasMore = rows.length > 0 && (total == null ? rows.length === balanceLimit : offset + rows.length < total);
  return { rows, hasMore };
}

export function balanceTable(rows, { hideBeneficiaryId = false } = {}) {
  const table = element('table');
  const keys = new Set(rows.flatMap(row => Object.keys(row)));
  if (hideBeneficiaryId && keys.size > 1) keys.delete('beneficiaryId');
  const columns = [...keys];
  const head = table.createTHead().insertRow();
  for (const key of columns) {
    const th = element('th', balanceLabels.get(key) ?? key);
    th.scope = 'col';
    head.append(th);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const key of columns) tr.insertCell().textContent = balanceValue(row[key]);
  }
  return table;
}

export function initBeneficiaries(request, refreshList) {
  let enabled = false;
  let active;
  let writing = false;
  let beneficiary;
  let returnFocus;
  let editor;
  let suspended = false;
  let balanceOffset = 0;
  let moreBalances = false;

  function controls() {
    const busy = !enabled || Boolean(active);
    for (const node of document.querySelectorAll('[data-beneficiary-action], #bank-list button')) node.disabled = busy;
    $('balance-prev').disabled = busy || !balanceOffset;
    $('balance-next').disabled = busy || !moreBalances;
    $('entity-fields').disabled = busy;
    $('entity-save').disabled = busy;
    $('entity-cancel').disabled = writing;
    $('beneficiary-close').disabled = writing;
    $('beneficiary-edit').disabled ||= !Object.hasOwn(beneficiaryFields, beneficiary?.type);
  }

  function showScreen() {
    $('entity-editor').hidden = !editor;
    $('list-panel').hidden = Boolean(editor || beneficiary);
    $('beneficiary-panel').hidden = Boolean(editor || !beneficiary);
    $('bank-section').hidden = $('beneficiary-panel').hidden;
    controls();
  }

  function resetEditor() {
    editor = undefined;
    $('entity-fields').replaceChildren();
    status('entity-status', '');
    showScreen();
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

  function close() {
    active?.abort();
    active = undefined;
    writing = false;
    suspended = false;
    beneficiary = undefined;
    returnFocus = undefined;
    balanceOffset = 0;
    moreBalances = false;
    $('balance-pages').hidden = true;
    $('balance-load').textContent = 'Показать баланс';
    $('balance-table').replaceChildren();
    status('balance-status', '');
    $('bank-detail').hidden = true;
    $('bank-retry').hidden = true;
    $('bank-id').value = '';
    for (const id of ['beneficiary-data', 'bank-list', 'bank-data']) $(id).replaceChildren();
    for (const id of ['beneficiary-status','beneficiary-feedback','bank-status','bank-availability']) status(id, '');
    resetEditor();
  }

  function setEnabled(value) {
    if (enabled && !value && !suspended) close();
    enabled = value;
    if (enabled) suspended = false;
    controls();
  }

  async function run(statusId, action, mutation = false) {
    if (!enabled || active) return;
    const controller = new AbortController();
    active = controller;
    writing = mutation;
    status(statusId, mutation ? 'Отправляем запрос…' : 'Загружаем данные…', 'loading');
    controls();
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        status(statusId, error.message, 'error');
        if (editor) showFieldErrors(error.details);
      }
    } finally {
      if (active === controller) {
        active = undefined;
        writing = false;
        controls();
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
    $('beneficiary-data').replaceChildren(detailFields(record, [
      { key: 'beneficiaryId', label: 'ID бенефициара' }, ...(beneficiaryFields[record.type] ?? []),
    ]));
    const addresses = itemGroup('Адреса', record.addresses, addressTypes, () => addressFields.filter(f => f.key !== 'type'));
    const documents = itemGroup('Документы', record.documents, documentTypes, item => documentFields[item.type] ?? []);
    if (addresses) $('beneficiary-data').append(addresses);
    if (documents) $('beneficiary-data').append(documents);
    $('item-id').value = record.beneficiaryId;
    showScreen();
    $('beneficiary-name').focus();
  }

  const bankPath = () => collection + '/' + beneficiary.beneficiaryId + '/bank-details';

  function displayBank(record) {
    $('bank-id').value = record.bankDetailsId;
    $('bank-record-title').textContent = 'Реквизиты · ' + (bankTypes[record.type] ?? record.type ?? '');
    $('bank-data').replaceChildren(detailFields(record, [
      { key: 'bankDetailsId', label: 'ID реквизитов' }, ...bankFields.PAYMENT_DETAILS,
    ]));
    $('bank-detail').hidden = false;
    $('bank-record-title').focus();
  }

  function openBank(id, edit = false, trigger) {
    return run('bank-status', async signal => {
      id = id.trim();
      if (!uuid.test(id)) throw new Error('Введите ID реквизитов в формате UUID.');
      const record = recordObject(await request(bankPath() + '/' + id, { signal }), 'bankDetails');
      if (record.type !== 'PAYMENT_DETAILS') throw new Error('Для этого типа реквизитов операции недоступны.');
      const full = { ...record, bankDetailsId: id };
      if (edit) startEditor('bank', full, trigger);
      else displayBank(full);
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
      $('bank-detail').hidden = true;
      $('bank-data').replaceChildren();
      $('bank-id').value = '';
      status('bank-status', deleting ? 'Реквизиты удалены.' : 'Основные реквизиты изменены.', 'success');
      await loadBank(signal);
    }, true);
  }

  function bankTable(records) {
    const table = element('table');
    const head = table.createTHead().insertRow();
    for (const name of ['Тип', 'Счёт или получатель', 'Банк', 'По умолчанию', 'Действия']) {
      const th = element('th', name);
      th.scope = 'col';
      head.append(th);
    }
    const body = table.createTBody();
    for (const record of records) {
      const row = body.insertRow();
      row.insertCell().textContent = bankTypes[record.type] ?? record.type ?? '—';
      const info = row.insertCell();
      const label = record.accountNumber || record.name || record.bankDetailsId || '—';
      const supported = record.type === 'PAYMENT_DETAILS' && uuid.test(record.bankDetailsId);
      if (supported) info.append(button(label, () => openBank(record.bankDetailsId), 'link'));
      else info.textContent = '—';
      row.insertCell().textContent = record.bankName || '—';
      row.insertCell().textContent = record.isDefault ? 'Да' : '—';
      const actionCell = row.insertCell();
      if (!supported) continue;
      const menu = element('details', '', 'row-actions');
      menu.append(element('summary', 'Действия'));
      menu.append(button('Редактировать', event => openBank(record.bankDetailsId, true, event.currentTarget)));
      if (!record.isDefault) menu.append(button('Сделать основными', () => changeBank(record, false)));
      menu.append(button('Удалить', () => changeBank(record, true), 'danger'));
      actionCell.append(menu);
    }
    return table;
  }
  async function loadBank(signal) {
    let offset = 0;
    const records = [];
    const ids = new Set();
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
      status('bank-availability', records.length ? '' : 'У бенефициара нет реквизитов.', 'success');
      if (records.length) $('bank-list').replaceChildren(bankTable(records));
      return records;
    } catch (error) {
      if (!signal.aborted) {
        status('bank-availability', error.message, 'error');
        $('bank-retry').hidden = false;
      }
    }
  }


  function loadBalances(offset) {
    return run('balance-status', async signal => {
      const beneficiaryId = beneficiary.beneficiaryId;
      const { rows, hasMore } = await fetchBalancePage(request, beneficiaryId, offset, signal);
      balanceOffset = offset;
      moreBalances = hasMore;
      $('balance-table').replaceChildren(...(rows.length ? [balanceTable(rows)] : []));
      $('balance-pages').hidden = !(offset || moreBalances);
      $('balance-load').textContent = 'Обновить баланс';
      const message = rows.length ? 'Строки ' + (offset + 1) + '–' + (offset + rows.length) :
        offset ? 'Больше записей нет.' : 'Данных об остатках нет.';
      status('balance-status', message, 'success');
    });
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
      await loadBank(signal);
    });
  }

  async function save(signal) {
    const { isBank, record, keys } = editor;
    showFieldErrors();
    const body = editor.read();
    const root = isBank ? bankPath() : collection;
    const id = isBank ? record?.bankDetailsId : record?.beneficiaryId;
    const payload = JSON.stringify(body);
    if (!record && !keys.has(payload)) keys.set(payload, crypto.randomUUID());
    const data = await request(id ? root + '/' + id : root, {
      method: id ? 'PUT' : 'POST', body, key: keys.get(payload), signal,
    });
    // The mutation succeeded. A failed follow-up read must not offer another creation.
    resetEditor();
    if (isBank) {
      $('bank-detail').hidden = true;
      $('bank-data').replaceChildren();
      $('bank-id').value = '';
      const result = data ? optionalRecord(data, 'bankDetails') : null;
      const savedId = result?.bankDetailsId ?? result?.id ?? id;
      status('bank-status', record ? 'Реквизиты обновлены.' : 'Реквизиты добавлены.', 'success');
      const rows = await loadBank(signal);
      signal.throwIfAborted();
      const saved = rows?.find(row => row.bankDetailsId === savedId);
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
    await loadBank(signal);
  }

  $('entity-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editor) run('entity-status', save, true);
  });
  $('entity-cancel').addEventListener('click', leaveEditor);
  $('beneficiary-create').addEventListener('click', event => startEditor('beneficiary', null, event.currentTarget));
  $('beneficiary-edit').addEventListener('click', event => startEditor('beneficiary', beneficiary, event.currentTarget));
  $('balance-load').addEventListener('click', () => loadBalances(0));
  $('balance-prev').addEventListener('click', () => loadBalances(Math.max(0, balanceOffset - balanceLimit)));
  $('balance-next').addEventListener('click', () => loadBalances(balanceOffset + balanceLimit));
  $('bank-create').addEventListener('click', event => startEditor('bank', null, event.currentTarget));
  $('bank-retry').addEventListener('click', () => run('bank-availability', loadBank));
  $('beneficiary-close').addEventListener('click', () => {
    const target = returnFocus?.isConnected ? returnFocus : $('results-title');
    close();
    target.focus();
  });
  $('bank-search').addEventListener('submit', event => {
    event.preventDefault();
    openBank($('bank-id').value);
  });
  window.addEventListener('beforeunload', event => {
    if (writing || editor?.dirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  return {
    close, open, setEnabled, leaveEditor,
    suspendDraft() { suspended = Boolean(editor); },
    get editing() { return Boolean(editor); },
  };
}
