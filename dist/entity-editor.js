import { addressFields, bankFields, beneficiaryFields, beneficiaryTypes, documentFields, documentTypes, validateBeneficiary } from './beneficiary-schema.js';

const $ = id => document.getElementById(id);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = 'secondary') {
  const control = element('button', text, className);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}

function choice(values, value, placeholder = 'Выберите вариант') {
  const select = element('select');
  select.add(new Option(placeholder, ''));
  for (const [key, label] of Object.entries(values)) select.add(new Option(label, key));
  select.value = value ?? '';
  return select;
}

function fields(container, descriptors, initial = {}) {
  const controls = descriptors.map((field) => {
    const label = element('label', field.label + (field.required ? ' *' : ''));
    let control;
    if (field.choices || field.type === 'boolean') {
      control = choice(field.choices ?? { true: 'Да', false: 'Нет' },
        initial[field.key], field.required ? 'Выберите вариант' : 'Не указывать');
    } else {
      control = element('input');
      control.type = field.type ?? 'text';
      control.value = initial[field.key] ?? '';
      if (field.pattern) control.pattern = field.pattern;
      if (field.maxLength) control.maxLength = field.maxLength;
      if (field.placeholder) control.placeholder = field.placeholder;
      if (field.inputMode) control.inputMode = field.inputMode;
    }
    control.name = field.key;
    control.required = Boolean(field.required);
    control.autocomplete = 'off';
    label.append(control);
    if (field.hint) label.append(element('small', field.hint, 'field-hint'));
    container.append(label);
    return [field, control];
  });
  return () => Object.fromEntries(controls.flatMap(([field, control]) => {
    const value = control.value.trim();
    if (!value) {
      if (field.required) throw new Error('Заполните поле «' + field.label + '».');
      return [];
    }
    return [[field.key, field.type === 'boolean' ? value === 'true' : value]];
  }));
}

function collectionFields(title, values, addText, renderRow) {
  const group = element('fieldset', null, 'field-group');
  group.append(element('legend', title));
  const list = element('div', null, 'field-rows');
  const readers = new Map();
  function add(initial) {
    const row = element('div', null, 'field-row');
    readers.set(row, renderRow(row, initial ?? {}));
    const remove = button('Убрать', () => {
      readers.delete(row);
      row.remove();
    }, 'secondary remove-field');
    remove.setAttribute('aria-label', 'Убрать запись из группы «' + title + '»');
    row.append(remove);
    list.append(row);
  }
  for (const value of values) add(value);
  group.append(list, button(addText, () => add()));
  return { group, read: () => Array.from(readers.values(), (read) => read()) };
}

function documentRow(row, initial, suggested) {
  const label = element('label', 'Тип документа *');
  const select = choice(documentTypes, initial.type ?? suggested);
  select.required = true;
  select.name = 'documentType';
  label.append(select);
  const grid = element('div', null, 'form-grid');
  row.append(label, grid);
  let read;
  function render(values) {
    grid.replaceChildren();
    read = fields(grid, documentFields[select.value] ?? [], values);
  }
  render(initial);
  select.addEventListener('change', () => {
    const shared = Object.fromEntries(Array.from(grid.querySelectorAll('[name]'), input => [input.name, input.value]));
    render(shared);
  });
  return () => ({ type: select.value, ...read() });
}


function snapshot() {
  return JSON.stringify(Array.from($('entity-fields').querySelectorAll('[name]'), el => [el.name, el.value]));
}

export function createEditor(kind, record, owner) {
  const isBank = kind === 'bank';
  const editing = Boolean(record);
  const title = isBank
    ? (editing ? 'Редактировать реквизиты' : 'Добавить реквизиты')
    : (editing ? 'Редактировать бенефициара' : 'Создать бенефициара');
  $('entity-title').textContent = title;
  $('entity-owner').textContent = owner?.label ?? '';
  $('entity-save').textContent = editing ? 'Сохранить изменения' : isBank ? 'Добавить реквизиты' : 'Создать бенефициара';
  const host = $('entity-fields');
  const body = element('div', null, 'editor-body');
  let type = record?.type ?? (isBank ? 'PAYMENT_DETAILS' : '');
  let selector;
  host.replaceChildren();
  if (!isBank) {
    selector = choice(beneficiaryTypes, type, 'Выберите тип бенефициара');
    selector.name = 'type';
    selector.required = true;
    const label = element('label', 'Тип бенефициара *');
    label.append(selector);
    host.append(label);
  }
  host.append(body);
  let readData;
  function render(initial) {
    body.replaceChildren();
    const grid = element('div', null, 'form-grid');
    const schema = isBank ? bankFields.PAYMENT_DETAILS : beneficiaryFields[type] ?? [];
    const descriptors = schema.map(field => isBank && field.key === 'kpp' && owner?.type === 'UL_RESIDENT'
      ? { ...field, required: true } : field);
    const readMain = fields(grid, descriptors, initial);
    body.append(grid);
    const collections = [];
    if (!isBank && type && type !== 'LITE_CONTACT') {
      body.append(element('p', 'Укажите телефон или электронную почту.', 'field-hint'));
      if (!type.startsWith('UL_')) {
        const suggested = type.endsWith('_NONRESIDENT') ? 'FOREIGN_PASSPORT' : 'PASSPORT';
        const docs = collectionFields('Документы', initial.documents ?? [], 'Добавить документ',
          (row, value) => documentRow(row, value, suggested));
        docs.group.dataset.collection = 'documents';
        body.append(docs.group);
        collections.push(['documents', docs.read]);
      }
      const addresses = collectionFields('Адреса', initial.addresses ?? [], 'Добавить адрес', (row, item) => {
        const grid = element('div', null, 'form-grid');
        row.append(grid);
        return fields(grid, addressFields, item);
      });
      addresses.group.dataset.collection = 'addresses';
      body.append(addresses.group);
      collections.push(['addresses', addresses.read]);
    }
    readData = () => {
      const data = { type, ...readMain() };
      for (const [key, read] of collections) {
        const rows = read();
        if (rows.length || Array.isArray(initial[key])) data[key] = rows;
      }
      if (!isBank) validateBeneficiary(data);
      return data;
    };
  }
  render(record ?? {});
  selector?.addEventListener('change', () => {
    if (body.querySelector('input, select') && Array.from(body.querySelectorAll('input, select')).some(el => el.value) &&
        !confirm('Сменить тип и очистить заполненные поля?')) {
      selector.value = type;
      return;
    }
    type = selector.value;
    render(type === record?.type ? record : {});
  });
  const initialSnapshot = snapshot();
  return { isBank, record, read: () => readData(), dirty: () => snapshot() !== initialSnapshot, keys: new Map() };
}

export function showFieldErrors(details) {
  const host = $('entity-fields');
  host.querySelectorAll('.field-error').forEach(node => node.remove());
  const controls = new Map();
  for (const input of host.querySelectorAll('[name]')) {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    const row = input.closest('.field-row');
    let path = input.name;
    if (row) {
      const index = Array.from(row.parentElement.children).indexOf(row);
      path = row.closest('[data-collection]').dataset.collection + '.' + index + '.' +
        (path === 'documentType' ? 'type' : path);
    }
    controls.set(path.toLowerCase(), input);
  }
  const messages = new Map();
  function visit(value, key) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, typeof child === 'string' ? key : key + '.' + index));
    } else if (value && typeof value === 'object') {
      for (const [field, child] of Object.entries(value)) visit(child, key ? key + '.' + field : field);
    } else if (typeof value === 'string') {
      const path = key.toLowerCase().replace(/\[(\d+)\]/g, '.$1').replace(/^(?:\$\.|body\.)+/, '');
      const control = controls.get(path);
      if (control) messages.set(control, [...(messages.get(control) ?? []), value]);
    }
  }
  visit(details, '');
  for (const [input, errors] of messages) {
    const label = element('small', errors.join(' '), 'field-error');
    label.id = 'error-' + Array.from(controls.values()).indexOf(input);
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', label.id);
    input.after(label);
  }
  messages.keys().next().value?.focus();
}
