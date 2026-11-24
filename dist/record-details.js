import { appendCopyId } from './copy-id.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const icons = {
  id: 'M3 5h18v14H3z M7 9h3v3H7z M6 16h5 M14 9h4 M14 13h4',
  money: 'M3 6h18v12H3z M3 10h18 M7 14h4',
  date: 'M4 6h16v15H4z M8 3v6 M16 3v6 M4 11h16 M8 15h2 M14 15h2',
  status: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M8.5 12l2.5 2.5 4.5-5',
  person: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M5 20v-2a7 5 0 0 1 14 0v2',
  bank: 'M3 9l9-5 9 5 M4 10h16 M7 10v8 M12 10v8 M17 10v8 M4 20h16',
  tag: 'M3 4h8l9 9-7 7-9-9z M7.5 8h.01',
  note: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17h.01',
  contact: 'M3 6h18v12H3z M3 7l9 6 9-6',
  place: 'M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Z M14 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  actions: 'M5 12h.01 M12 12h.01 M19 12h.01',
  list: 'M4 6h2 M4 12h2 M4 18h2 M9 6h11 M9 12h11 M9 18h11',
};

export function isIdField(path) {
  const key = path.split('.').findLast(part => !/^\d+$/.test(part)) ?? '';
  return /^(id|uuid)$/i.test(key) || /(?:Ids?|IDs?|_ids?)$/.test(key);
}

function iconFor(path) {
  const key = path.split('.').at(-1);
  if (/errorMessage|ошибк|предупрежден/i.test(key)) return 'alert';
  if (isIdField(path) || /^id[\s-]|^инн$|^inn$|^снилс$|^snils$|^kpp$|^кпп$|token/i.test(key)) return 'id';
  if (/amount|currency|balance|сумм|баланс|валют|остаток|зарезерв/i.test(key)) return 'money';
  if (/date|createdAt|updatedAt|дата|период/i.test(key)) return 'date';
  if (/status|статус|по умолчанию/i.test(key)) return 'status';
  if (/account|bank|bik|swift|сч[её]т|банк|бик|реквизит/i.test(key)) return 'bank';
  if (/email|phone|телефон|почта/i.test(key)) return 'contact';
  if (/address|place|адрес|место рождения/i.test(key)) return 'place';
  if (/name|бенефициар|плательщик|получатель|отправитель|фамилия|отчество|billing-from/i.test(key) || /^(from|to)\./.test(path)) return 'person';
  if (/type|тип|вид платежа|получение/i.test(key)) return 'tag';
  if (/действия/i.test(key)) return 'actions';
  if (/строк|странице|^№$/i.test(key)) return 'list';
  return 'note';
}

function labelIcon(name) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('class', 'record-field-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', icons[name]);
  svg.append(path);
  return svg;
}

export function fieldCaption(label, key = label) {
  const caption = document.createElement('span');
  caption.className = 'field-caption';
  if (label) caption.title = label;
  const text = document.createElement('span');
  text.className = 'field-caption-text';
  text.append(label);
  caption.append(labelIcon(iconFor(key)), text);
  return caption;
}

export function decorateFormLabels(root) {
  for (const label of root.querySelectorAll('label')) {
    if (label.querySelector(':scope > .field-caption')) continue;
    const title = Array.from(label.childNodes).find(node =>
      (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) || (node instanceof HTMLSpanElement && node.id));
    if (!title) continue;
    const text = title.textContent.trim();
    const caption = fieldCaption(text, text || label.htmlFor);
    title.replaceWith(caption);
    if (title.nodeType === Node.ELEMENT_NODE) caption.lastElementChild.replaceChildren(title);
  }
}

export function tableHeaders(table, columns) {
  table.classList.add('data-table');
  const row = table.createTHead().insertRow();
  for (const label of columns) {
    const header = document.createElement('th');
    header.scope = 'col';
    header.append(fieldCaption(label));
    row.append(header);
  }
}

export function tableCell(row, value) {
  const cell = row.insertCell();
  if (value instanceof HTMLElement) cell.append(value);
  else {
    const content = document.createElement('span');
    content.className = 'table-value';
    content.textContent = value ?? '—';
    content.title = content.textContent;
    cell.append(content);
  }
  return cell;
}

export function insertExpandedRow(source, details) {
  const row = document.createElement('tr');
  row.className = 'expanded-row';
  const cell = row.insertCell();
  cell.colSpan = source.cells.length;
  cell.append(details);
  source.after(row);
  return row;
}

export function recordField(path, label, value, { primary = false } = {}) {
  const key = path.split('.').at(-1);
  const field = document.createElement('div');
  field.className = 'record-field';
  if (primary) field.classList.add('record-field-primary');
  if (iconFor(path) === 'id') field.classList.add('record-field-id');
  if (/^(operationAmount|amount)$/.test(key)) field.classList.add('record-field-amount');
  if (/^(purpose|paymentPurpose|errorMessage|description|address)$/.test(key)) field.classList.add('record-field-full');

  const term = document.createElement('dt');
  const caption = fieldCaption(label, path);
  term.append(caption);

  const definition = document.createElement('dd');
  const content = document.createElement('span');
  content.className = 'record-value';
  if (value instanceof HTMLElement) content.append(value);
  else {
    content.textContent = String(value);
    content.title = content.textContent;
  }
  definition.append(content);
  if (isIdField(path)) appendCopyId(definition, value, label);
  field.append(term, definition);
  return field;
}

export function recordDetails(item, labels, primaryKey, groups) {
  const layout = document.createDocumentFragment();
  const fieldLabels = new Map(labels);
  const containers = new Set();
  for (const path of fieldLabels.keys()) {
    const parts = path.split('.');
    for (let count = 1; count < parts.length; count++) containers.add(parts.slice(0, count).join('.'));
  }
  const claimed = new Set(groups.flatMap(group => group.keys ?? []));
  for (const { title, keys, unwrap, summary } of groups) {
    const grid = document.createElement('dl');
    grid.className = summary ? 'record-fields record-summary-fields' : 'record-fields';
    function add(key, value, path, prefix = '') {
      if (value == null || value === '') return;
      const caption = fieldLabels.get(path);
      if (!caption) return;
      const label = prefix ? prefix + ' · ' + caption : caption;
      if (containers.has(path)) {
        if (typeof value !== 'object' || Array.isArray(value)) return;
        const parent = unwrap && path === key ? '' : label;
        for (const [child, part] of Object.entries(value)) add(child, part, path + '.' + child, parent);
      } else if (typeof value !== 'object' || value instanceof HTMLElement) {
        grid.append(recordField(path, label, value, { primary: path === primaryKey }));
      }
    }
    const entries = keys ? keys.map(key => [key, item[key]]) : Object.entries(item).filter(([key]) => !claimed.has(key));
    for (const [key, value] of entries) add(key, value, key);
    if (!grid.childElementCount) continue;

    const section = document.createElement('section');
    section.className = summary ? 'record-section record-summary' : 'record-section';
    if (title) {
      const heading = document.createElement('h3');
      heading.textContent = title;
      section.append(heading);
    }
    section.append(grid);
    layout.append(section);
  }
  return layout;
}
