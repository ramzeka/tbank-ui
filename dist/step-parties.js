import { decimal, minorUnits } from './amount.js';
import { beneficiaryName, fetchBeneficiary, listPage } from './beneficiaries.js';
import { appendCopyId } from './copy-id.js';
import { insertExpandedRow, recordField, tableCell, tableHeaders } from './record-details.js';

const $ = id => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const limit = 50;
const maxOffset = 2147483647;
const amountFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = 'secondary') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function status(id, text, state = 'idle') {
  $(id).textContent = text;
  $(id).dataset.state = state;
}

function sameId(left, right) {
  return typeof left === 'string' && left.toLowerCase() === right?.toLowerCase();
}

function formatAmount(value) {
  const amount = minorUnits(value);
  return amount === null ? String(value ?? '—') : amountFormat.format(Number(decimal(amount)));
}

function destination(item) {
  return item.keepOnVirtualAccount === true || !item.bankDetailsId ? 'Виртуальный счёт' : 'Банковские реквизиты';
}

export function initStepParties({ request, run, record, invalidateValidation }) {
  const dialog = $('party-dialog');
  const beneficiary = $('party-beneficiary');
  const bank = $('party-bank');
  const payout = $('party-destination');
  const bankOptions = $('party-bank-options');
  const groups = [];
  let context;
  let editor;
  let busy = true;

  const pathFor = group => context.path + '/' + group.route;

  function syncFields() {
    const repair = editor?.mode === 'repair';
    const recipient = Boolean(editor?.group.recipient);
    const showBank = repair || (recipient && payout.value === 'bank');
    const fields = {
      'party-amount': !repair,
      'party-purpose': recipient && !repair,
      'party-destination': recipient && !repair,
      'party-bank': showBank,
    };
    for (const [id, show] of Object.entries(fields)) {
      $(id).parentElement.hidden = !show;
      $(id).disabled = !show;
    }
  }

  function setBusy(value, writing) {
    busy = value;
    for (const group of groups) {
      group.add.hidden = !context?.draft;
      for (const control of group.region.querySelectorAll('button')) control.disabled = busy || !context;
      group.previous.disabled ||= !group.offset;
      group.next.disabled ||= !group.hasMore;
    }
    $('party-fields').disabled = $('party-save').disabled = busy;
    $('party-form-cancel').disabled = writing;
  }

  function clearDetails(group, restoreFocus = false) {
    if (!group.expanded) return;
    const { row, trigger } = group.expanded;
    group.expanded = undefined;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    row.remove();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function closeEditor() {
    editor = undefined;
    $('party-form').reset();
    bankOptions.replaceChildren();
    status('party-lookup-status', '');
    status('party-editor-status', '');
    if (dialog.open) dialog.close();
  }

  function close() {
    context = undefined;
    closeEditor();
    for (const group of groups) {
      group.offset = 0;
      group.hasMore = false;
      clearDetails(group);
      group.table.replaceChildren();
      group.pages.hidden = true;
      status(group.status, '');
    }
  }

  function matchesStage(item) {
    return (item.dealId == null || sameId(item.dealId, context.dealId)) &&
      (item.stepId == null || sameId(item.stepId, context.stepId));
  }

  async function readItem(group, id, signal) {
    const data = await request(pathFor(group) + '/' + id, { signal });
    signal.throwIfAborted();
    const item = record(data, group.key);
    if (!item || !sameId(item[group.key], id) || !matchesStage(item)) {
      throw new Error('Прокси вернул данные другого участника или этапа.');
    }
    return item;
  }

  function showDetails(group, item, trigger) {
    const id = item[group.key];
    const details = element('section', null, 'bank-detail step-party-detail');
    details.id = group.route + '-detail-' + id;
    const title = element('h5', group.recipient ? 'Реципиент' : 'Депонент');
    title.id = details.id + '-title';
    title.tabIndex = -1;
    details.setAttribute('aria-labelledby', title.id);
    const fields = [['name', 'Имя / наименование', item.beneficiaryName ?? item.name], ['beneficiaryId', 'ID бенефициара', item.beneficiaryId],
      ['amount', 'Сумма', formatAmount(item.amount)]];
    if (group.recipient) fields.push(
      ['recipientId', 'ID реципиента', item.recipientId], ['destination', 'Получение', destination(item)],
      ['bankDetailsId', 'ID реквизитов', item.bankDetailsId], ['purpose', 'Назначение платежа', item.purpose],
    );
    const values = element('dl', null, 'record-fields standalone-fields');
    values.append(...fields.flatMap(([key, label, value]) =>
      value == null || value === '' ? [] : [recordField(key, label, value)],
    ));
    details.append(title, values);
    const actions = element('div', null, 'actions');
    if (context.draft) {
      actions.append(button('Редактировать', () => editItem(group, id, 'edit')),
        button('Удалить', () => remove(group, item), 'danger'));
    }
    if (group.recipient && context.repair) {
      actions.append(button('Обновить реквизиты', () => editItem(group, id, 'repair')));
    }
    if (actions.childElementCount) details.append(actions);
    group.expanded = { row: insertExpandedRow(trigger.closest('tr'), details), trigger };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', details.id);
    title.focus();
  }

  function openItem(group, id, trigger) {
    if (group.expanded?.trigger === trigger) return clearDetails(group, true);
    run(group.status, async signal => {
      clearDetails(group);
      const item = await readItem(group, id, signal);
      status(group.status, '');
      showDetails(group, item, trigger);
    });
  }

  function editItem(group, id, mode) {
    run(group.status, async signal => {
      const item = await readItem(group, id, signal);
      status(group.status, '');
      openEditor(group, mode, item);
    });
  }

  function tableFor(group, rows) {
    const table = element('table');
    const columns = ['Бенефициар', 'Сумма'];
    if (group.recipient) columns.push('Получение', 'Назначение платежа');
    tableHeaders(table, columns);
    const body = table.createTBody();
    for (const item of rows) {
      const row = body.insertRow();
      const id = item[group.key];
      const participant = row.insertCell();
      const fallback = item.beneficiaryId || '—';
      if (uuid.test(id)) {
        const link = button(item.beneficiaryId || 'Открыть', event => openItem(group, id, event.currentTarget), 'link');
        link.setAttribute('aria-expanded', 'false');
        if (item.beneficiaryId) link.title = item.beneficiaryId;
        participant.append(link);
      } else {
        participant.append(element('span', fallback, 'table-value'));
      }
      appendCopyId(participant, item.beneficiaryId, 'ID бенефициара');
      tableCell(row, formatAmount(item.amount));
      if (group.recipient) {
        tableCell(row, destination(item));
        tableCell(row, item.purpose || null);
      }
    }
    return table;
  }

  async function load(group, offset, signal) {
    clearDetails(group);
    const read = async position => listPage(
      await request(pathFor(group), { query: { offset: position, limit }, signal }),
      [group.route], [group.key, 'amount'],
    );
    let { rows, total } = await read(offset);
    if (!rows.length && offset) {
      offset = total === undefined ? offset - limit : Math.min(offset - limit, Math.max(0, Math.ceil(total / limit) - 1) * limit);
      ({ rows, total } = await read(offset));
    }
    signal.throwIfAborted();
    if (rows.some(item => !matchesStage(item))) throw new Error('Прокси вернул участников другого этапа.');
    group.offset = offset;
    group.hasMore = offset + limit <= maxOffset && (total === undefined ? rows.length === limit : offset + limit < total);
    group.table.replaceChildren(...(rows.length ? [tableFor(group, rows)] : []));
    group.pages.hidden = !(offset || group.hasMore);
    group.count.textContent = total === undefined ? '' : 'Всего ' + total.toLocaleString('ru-RU');
    status(group.status, rows.length ? '' : group.empty);
  }

  function show(stage, signal) {
    context = stage;
    return Promise.all(groups.map(async group => {
      status(group.status, 'Загружаем данные…', 'loading');
      try {
        await load(group, 0, signal);
      } catch (error) {
        if (!signal.aborted) status(group.status, error.message, 'error');
      }
    }));
  }

  function openEditor(group, mode, item) {
    editor = { group, mode, item };
    const title = mode === 'repair' ? 'Обновить реквизиты реципиента' :
      (mode === 'edit' ? 'Редактировать ' : 'Добавить ') + group.name;
    $('party-editor-title').textContent = title;
    beneficiary.value = item?.beneficiaryId ?? '';
    beneficiary.readOnly = mode === 'repair' || (!group.recipient && mode === 'edit');
    $('party-amount').value = item?.amount == null ? '' : String(item.amount).replace('.', ',');
    $('party-purpose').value = item?.purpose ?? '';
    payout.value = item && destination(item) === 'Банковские реквизиты' ? 'bank' : 'virtual';
    bank.value = item?.bankDetailsId ?? '';
    $('party-upsert-hint').hidden = group.recipient || mode !== 'add';
    for (const id of ['party-lookup-status', 'party-editor-status']) status(id, '');
    bankOptions.replaceChildren();
    syncFields();
    dialog.showModal();
    (mode === 'repair' ? bank : beneficiary.readOnly ? $('party-amount') : beneficiary).focus();
  }

  function beneficiaryId() {
    const id = beneficiary.value.trim().toLowerCase();
    if (!uuid.test(id)) throw new Error('Введите ID бенефициара в формате UUID.');
    return id;
  }

  async function lookup(signal) {
    const id = beneficiaryId();
    const person = await fetchBeneficiary(request, id, signal);
    status('party-lookup-status', beneficiaryName(person), 'success');
    if (bank.disabled) return;
    const data = await request('/beneficiaries/' + id + '/bank-details', { query: { offset: 0, limit }, signal });
    const { rows } = listPage(data, ['bankDetails', 'requisites'], ['bankDetailsId', 'accountNumber']);
    const options = rows.filter(item => uuid.test(item.bankDetailsId ?? item.id)).map(item => {
      const label = [item.bankName, item.accountNumber && '…' + String(item.accountNumber).slice(-4)].filter(Boolean).join(' ');
      return new Option(label, item.bankDetailsId ?? item.id);
    });
    bankOptions.replaceChildren(...options);
  }

  async function refreshAfterWrite(group, text, signal) {
    invalidateValidation();
    clearDetails(group);
    group.table.replaceChildren();
    group.pages.hidden = true;
    try {
      await load(group, group.offset, signal);
      status(group.status, text, 'success');
    } catch (error) {
      signal.throwIfAborted();
      status(group.status, text + ' Не удалось обновить список. ' + error.message, 'error');
    }
  }

  async function save(signal) {
    const { group, mode, item } = editor;
    const id = beneficiaryId();
    const repair = mode === 'repair';
    const bankDetailsId = bank.value.trim().toLowerCase();
    const includeBank = repair || (group.recipient && payout.value === 'bank');
    if (includeBank && !uuid.test(bankDetailsId)) throw new Error('Введите ID банковских реквизитов в формате UUID.');
    let path = pathFor(group);
    let method = 'PUT';
    let body;
    if (repair) {
      path += '/' + item.recipientId + '/update-bank-details';
      method = 'POST';
      body = { bankDetailsId };
    } else {
      const units = minorUnits($('party-amount').value);
      const amount = units == null ? NaN : Number(decimal(units));
      if (units == null || units <= 0n || minorUnits(amount) !== units) {
        throw new Error('Введите положительную сумму с точностью до копеек.');
      }
      body = { amount };
      if (group.recipient) {
        body.beneficiaryId = id;
        body.keepOnVirtualAccount = !includeBank;
        const purpose = $('party-purpose').value.trim();
        if (purpose) body.purpose = purpose;
        if (includeBank) body.bankDetailsId = bankDetailsId;
        if (item) path += '/' + item.recipientId;
        else method = 'POST';
      } else path += '/' + id;
    }
    await request(path, { method, body, idempotent: method === 'POST' && !item, signal });
    closeEditor();
    await refreshAfterWrite(group, 'Изменения сохранены.', signal);
  }

  function remove(group, item) {
    const id = item[group.key];
    if (busy || !confirm('Удалить ' + group.name + ' из этапа?\nID ' + id)) return;
    run(group.status, async signal => {
      await request(pathFor(group) + '/' + id, { method: 'DELETE', signal });
      await refreshAfterWrite(group, 'Участник удалён из этапа.', signal);
    }, true);
  }

  for (const [route, title, name, key, empty] of [
    ['deponents', 'Депоненты', 'депонента', 'beneficiaryId', 'У этапа пока нет депонентов.'],
    ['recipients', 'Реципиенты', 'реципиента', 'recipientId', 'У этапа пока нет реципиентов.'],
  ]) {
    const region = $('step-party-group').content.firstElementChild.cloneNode(true);
    const heading = region.querySelector('h4');
    heading.id = route + '-title';
    heading.textContent = title;
    region.setAttribute('aria-labelledby', heading.id);
    const feedback = region.querySelector('.notice-message');
    feedback.id = route + '-status';
    const group = {
      route, name, key, empty, region, status: feedback.id,
      recipient: route === 'recipients', offset: 0, hasMore: false,
      add: region.querySelector('[data-action=add]'),
      previous: region.querySelector('[data-action=previous]'),
      next: region.querySelector('[data-action=next]'),
      table: region.querySelector('[data-part=table]'),
      pages: region.querySelector('[data-part=pages]'),
      count: region.querySelector('.page-summary'),
    };
    group.add.textContent = 'Добавить ' + name;
    group.add.addEventListener('click', () => openEditor(group, 'add'));
    region.querySelector('[data-action=refresh]').addEventListener('click', () => run(group.status, signal => load(group, group.offset, signal)));
    group.previous.addEventListener('click', () => run(group.status, signal => load(group, Math.max(0, group.offset - limit), signal)));
    group.next.addEventListener('click', () => run(group.status, signal => load(group, group.offset + limit, signal)));
    $('step-parties').append(region);
    groups.push(group);
  }
  payout.addEventListener('change', syncFields);
  beneficiary.addEventListener('input', () => {
    bankOptions.replaceChildren();
    bank.value = '';
    status('party-lookup-status', '');
  });
  $('party-lookup').addEventListener('click', () => run('party-lookup-status', lookup));
  $('party-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editor) run('party-editor-status', save, true);
  });
  $('party-form-cancel').addEventListener('click', closeEditor);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!$('party-form-cancel').disabled) closeEditor();
  });

  return { show, close, setBusy };
}
