import {
  addressFields, addressTypes, bankFields, bankTypes, beneficiaryFields, beneficiaryTypes, documentFields, documentTypes,
} from './beneficiary-schema.js';

const $ = (id) => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const collection = '/beneficiaries';
const bankLimit = 50;

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

function recordObject(data, key) {
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
  const record = unwrap(data, 0);
  if (!record) throw new Error('Не удалось распознать карточку в ответе прокси.');
  return record;
}

function textValue(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

function detailFields(record, fields, typeLabel) {
  const grid = element('div', '', 'form-grid readonly-fields');
  for (const { key, label } of fields) {
    const value = key === 'type' && typeLabel ? typeLabel : record[key];
    if (value == null || value === '') continue;
    const wrapper = element('label', label);
    const input = element('input');
    input.readOnly = true;
    input.value = textValue(value);
    wrapper.append(input);
    grid.append(wrapper);
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

const bankIdentity = [
  { key: 'bankDetailsId', label: 'ID реквизитов' },
  { key: 'type', label: 'Тип' },
  { key: 'isDefault', label: 'По умолчанию' },
];
const bankColumns = [...bankIdentity, { key: 'cardId', label: 'ID карты' },
  ...[...new Map(Object.values(bankFields).flat().map((field) => [field.key, field])).values()]
    .filter(({ key }) => !['isDefault', 'cardData'].includes(key))];

function bankTable(records, open) {
  const columns = bankColumns.filter(({ key }) => bankIdentity.some((field) => field.key === key) ||
    records.some((record) => record[key] != null && record[key] !== ''));
  const table = element('table');
  const header = table.createTHead().insertRow();
  for (const { label } of columns) {
    const th = element('th', label);
    th.scope = 'col';
    header.append(th);
  }
  const body = table.createTBody();
  for (const record of records) {
    const row = body.insertRow();
    for (const { key } of columns) {
      const cell = row.insertCell();
      const value = key === 'type' ? bankTypes[record.type] ?? record.type : record[key];
      if (key === 'bankDetailsId' && open && uuid.test(value)) {
        const button = element('button', value, 'link');
        button.type = 'button';
        button.addEventListener('click', () => open(value));
        cell.append(button);
      } else {
        cell.textContent = textValue(value);
      }
    }
  }
  return table;
}

export function initBeneficiaries(request) {
  let enabled = false;
  let active;
  let selectedId;

  function controls() {
    for (const node of document.querySelectorAll('[data-beneficiary-action], #bank-list button')) {
      node.disabled = !enabled || Boolean(active);
    }
  }

  function close() {
    active?.abort();
    active = undefined;
    selectedId = undefined;
    $('beneficiary-panel').hidden = true;
    $('bank-section').hidden = true;
    $('bank-detail').hidden = true;
    $('bank-id').value = '';
    for (const id of ['beneficiary-data', 'bank-list', 'bank-data']) $(id).replaceChildren();
    status('beneficiary-status', '');
    status('bank-status', '');
    status('bank-availability', '');
    controls();
  }

  function setEnabled(value) {
    if (enabled && !value) close();
    enabled = value;
    controls();
  }

  async function run(statusId, action) {
    if (!enabled || active) return;
    const controller = new AbortController();
    active = controller;
    status(statusId, 'Загружаем данные…', 'loading');
    controls();
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) status(statusId, error.message, 'error');
    } finally {
      if (active === controller) active = undefined;
      controls();
    }
  }

  const bankPath = () => collection + '/' + selectedId + '/bank-details';
  const openBank = (id) => run('bank-status', async (signal) => {
    id = id.trim();
    if (!uuid.test(id)) throw new Error('Введите ID реквизитов в формате UUID.');
    const record = recordObject(await request(bankPath() + '/' + id, { signal }), 'bankDetails');
    $('bank-data').replaceChildren(bankTable([{ ...record, bankDetailsId: id }]));
    $('bank-detail').hidden = false;
    $('bank-record-title').focus();
    status('bank-status', '');
  });

  async function loadBank(signal) {
    let offset = 0;
    const records = [];
    const ids = new Set();
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
      if (records.length) {
        $('bank-list').replaceChildren(bankTable(records, openBank));
        $('bank-section').hidden = false;
      }
    } catch (error) {
      if (!signal.aborted) status('bank-availability', error.message, 'error');
    }
  }

  function open(id) {
    if (!enabled) return;
    close();
    return run('beneficiary-status', async (signal) => {
      id = id.trim();
      if (!uuid.test(id)) throw new Error('Введите ID бенефициара в формате UUID.');
      const record = recordObject(await request(collection + '/' + id, { signal }), 'beneficiary');
      selectedId = id;
      $('beneficiary-name').textContent = beneficiaryName(record);
      $('beneficiary-type').textContent = beneficiaryTypes[record.type] ?? record.type ?? '';
      $('beneficiary-data').replaceChildren(detailFields({ ...record, beneficiaryId: id }, [
        { key: 'beneficiaryId', label: 'ID бенефициара' }, ...(beneficiaryFields[record.type] ?? []),
      ]));
      const addresses = itemGroup('Адреса', record.addresses, addressTypes, () => addressFields.filter(({ key }) => key !== 'type'));
      const documents = itemGroup('Документы', record.documents, documentTypes, (item) => documentFields[item.type] ?? []);
      if (addresses) $('beneficiary-data').append(addresses);
      if (documents) $('beneficiary-data').append(documents);
      $('item-id').value = id;
      $('beneficiary-panel').hidden = false;
      $('beneficiary-name').focus();
      status('beneficiary-status', '');
      await loadBank(signal);
    });
  }

  $('beneficiary-close').addEventListener('click', close);
  $('bank-search').addEventListener('submit', (event) => {
    event.preventDefault();
    openBank($('bank-id').value);
  });
  return { open, setEnabled };
}

