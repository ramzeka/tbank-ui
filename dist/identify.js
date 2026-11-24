import { balanceTable, beneficiaryName, fetchBalancePage, fetchBeneficiary } from './beneficiaries.js';
import { beneficiaryTypes } from './beneficiary-schema.js';
import { decimal, minorUnits } from './amount.js';
import { decorateFormLabels, recordField } from './record-details.js';

const $ = id => document.getElementById(id);

function status(node, message, state = 'idle') {
  node.textContent = message;
  node.dataset.state = state;
}

function display(units, currency) {
  return decimal(units).replace('.', ',') + (currency ? ' ' + currency : '');
}

function bindRecipientCheck(row, request, uuid, sessionSignal) {
  const input = row.querySelector('[name=beneficiaryId]');
  const check = row.querySelector('.recipient-check');
  const preview = row.querySelector('.recipient-preview');
  const info = row.querySelector('.recipient-info');
  const infoStatus = row.querySelector('.recipient-info-status');
  const balances = row.querySelector('.recipient-balances');
  const balanceStatus = row.querySelector('.recipient-balance-status');
  const more = row.querySelector('.recipient-more');
  let controller;
  let balanceRows = [];
  let lastId;

  function reset() {
    controller?.abort();
    balanceRows = [];
    lastId = input.value.trim().toLowerCase();
    check.hidden = !uuid.test(lastId);
    check.disabled = false;
    check.textContent = 'Проверить бенефициара';
    preview.hidden = true;
    info.replaceChildren();
    status(infoStatus, '');
    status(balanceStatus, '');
    balances.replaceChildren();
    more.hidden = true;
  }

  async function showInfo(id, signal) {
    try {
      const record = await fetchBeneficiary(request, id, signal);
      if (signal.aborted) return;
      const name = beneficiaryName(record);
      const type = beneficiaryTypes[record.type] ?? record.type;
      const fields = document.createElement('dl');
      fields.className = 'record-fields';
      fields.append(recordField('name', 'Имя / наименование', name));
      if (type && type !== name) fields.append(recordField('type', 'Тип', type));
      if (record.inn) fields.append(recordField('inn', 'ИНН', record.inn));
      info.replaceChildren(fields);
      status(infoStatus, '');
    } catch (error) {
      if (signal.aborted) return;
      status(infoStatus, 'Данные бенефициара. ' + error.message, 'error');
    }
  }

  async function showBalances(id, signal) {
    more.disabled = true;
    status(balanceStatus, 'Загружаем остатки…', 'loading');
    try {
      const page = await fetchBalancePage(request, id, balanceRows.length, signal);
      if (signal.aborted) return;
      balanceRows.push(...page.rows);
      if (balanceRows.length) balances.replaceChildren(balanceTable(balanceRows, { hideBeneficiaryId: true }));
      status(balanceStatus, balanceRows.length ? '' : 'Данных об остатках нет.');
      more.hidden = !page.hasMore;
    } catch (error) {
      if (signal.aborted) return;
      status(balanceStatus, error.message, 'error');
    } finally {
      if (!signal.aborted) more.disabled = false;
    }
  }

  check.addEventListener('click', async () => {
    reset();
    if (check.hidden) return;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const id = lastId;
    check.disabled = true;
    preview.hidden = false;
    status(infoStatus, 'Загружаем данные бенефициара…', 'loading');
    more.onclick = () => showBalances(id, signal);
    await Promise.all([showInfo(id, signal), showBalances(id, signal)]);
    if (signal.aborted) return;
    check.textContent = 'Обновить данные';
    check.disabled = false;
  });

  input.addEventListener('input', () => {
    if (input.value.trim().toLowerCase() !== lastId) reset();
  });
  reset();
  return reset;
}

export function initIdentification({ request, uuid, verify, onResult }) {
  const dialog = $('identify-dialog');
  const rows = $('distribution-rows');
  const feedback = $('identify-status');
  const checkOutcome = $('identify-verify');
  const completed = new Set();
  const uncertain = new Set();
  for (const [id, label] of [['distribution-total', 'Распределено'], ['distribution-left', 'Осталось']]) {
    const value = document.createElement('strong');
    value.id = id;
    $('distribution-summary').append(recordField('amount', label, value));
  }
  let current;

  function controls() {
    const { sending, checking, needsCheck, returnToList } = current;
    $('identify-fields').disabled = sending || needsCheck;
    $('identify-submit').disabled = sending || needsCheck;
    $('identify-cancel').disabled = sending;
    $('identify-cancel').textContent = returnToList ? 'К списку' : 'Отмена';
    checkOutcome.hidden = !needsCheck || returnToList;
    checkOutcome.disabled = checking;
  }

  function values() {
    return Array.from(rows.children, row => ({
      beneficiaryId: row.querySelector('[name=beneficiaryId]').value.trim(),
      amount: row.querySelector('[name=amount]').value.trim(),
    }));
  }

  function distributed() {
    return values().reduce((total, row) => total + (minorUnits(row.amount) ?? 0n), 0n);
  }

  function updateTotals() {
    const used = distributed();
    $('distribution-total').textContent = display(used, current.currency);
    $('distribution-left').textContent = display(current.total - used, current.currency);
    for (const button of rows.querySelectorAll('.distribution-remove')) button.disabled = rows.childElementCount === 1;
  }

  function addRow(id, amount) {
    const row = $('distribution-row').content.firstElementChild.cloneNode(true);
    decorateFormLabels(row);
    const input = row.querySelector('[name=beneficiaryId]');
    input.pattern = uuid.source;
    input.value = id;
    row.querySelector('[name=amount]').value = amount;
    const resetPreview = bindRecipientCheck(row, request, uuid, current.abort.signal);
    row.querySelector('.distribution-remove').addEventListener('click', () => {
      resetPreview();
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      updateTotals();
      next?.querySelector('input').focus();
    });
    rows.append(row);
    updateTotals();
    return input;
  }

  function close() {
    current?.abort.abort();
    current = undefined;
    if (dialog.open) dialog.close();
    $('identify-summary').replaceChildren();
    $('distribution-total').textContent = '';
    $('distribution-left').textContent = '';
    rows.replaceChildren();
    status(feedback, '');
  }

  function dismiss() {
    const state = current;
    if (!state || state.sending) return;
    close();
    if (state.returnToList) onResult(state.operationId, state.returnToList);
  }

  function open(item, total) {
    const operationId = item.operationId;
    if (current || completed.has(operationId)) return;
    current = {
      operationId, total, currency: item.currency ?? item.operationCurrency ?? '',
      abort: new AbortController(), needsCheck: uncertain.has(operationId),
    };
    const summary = $('identify-summary');
    summary.replaceChildren(recordField('operationId', 'ID операции', operationId, { primary: true }),
      recordField('amount', 'Сумма пополнения', display(total, current.currency)));
    if (item.payerName) summary.append(recordField('payerName', 'Плательщик', item.payerName));
    status(feedback, current.needsCheck ? 'Перед повтором проверьте пополнение по ID.' : '');
    addRow('', decimal(total).replace('.', ','));
    controls();
    dialog.showModal();
    (current.needsCheck ? checkOutcome : rows.querySelector('input')).focus();
  }

  function buttonFor(item) {
    const total = minorUnits(item.amount ?? item.operationAmount);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'create-action';
    button.textContent = completed.has(item.operationId) ? 'Идентифицировано' : 'Идентифицировать';
    button.disabled = !uuid.test(item.operationId) || total === null || total <= 0n || completed.has(item.operationId);
    if (button.disabled && !completed.has(item.operationId)) button.title = 'Для распределения нужны ID операции и положительная сумма пополнения.';
    button.addEventListener('click', () => open(item, total));
    return button;
  }

  $('distribution-add').addEventListener('click', () => {
    const remaining = current.total - distributed();
    addRow('', remaining > 0n ? decimal(remaining).replace('.', ',') : '').focus();
  });
  rows.addEventListener('input', () => {
    for (const input of rows.querySelectorAll('input')) input.setCustomValidity('');
    status(feedback, '');
    updateTotals();
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dismiss();
  });
  $('identify-cancel').addEventListener('click', dismiss);

  checkOutcome.addEventListener('click', async () => {
    const state = current;
    if (!state?.needsCheck || state.checking || state.returnToList) return;
    state.checking = true;
    controls();
    status(feedback, 'Ищем пополнение в актуальном списке…', 'loading');
    try {
      const item = await verify(state.operationId, state.abort.signal, count => {
        status(feedback, 'Ищем пополнение… Проверено записей: ' + count + '.', 'loading');
      });
      if (state !== current) return;
      if (!item) {
        state.returnToList = 'Пополнение отсутствует в списке неидентифицированных. Сверьте распределение по ID операции и остаткам бенефициаров.';
      } else if (minorUnits(item.amount ?? item.operationAmount) !== state.total ||
        (item.currency ?? item.operationCurrency ?? '') !== state.currency) {
        state.returnToList = 'Данные пополнения изменились. Откройте его заново из обновленного списка.';
      } else {
        uncertain.delete(state.operationId);
        state.needsCheck = false;
      }
      status(feedback, state.returnToList ?? 'Пополнение всё ещё в списке. Проверьте распределение и повторите отправку.', 'warning');
    } catch (error) {
      if (state === current) status(feedback, 'Проверка пополнения не удалась. ' + error.message, 'error');
    } finally {
      if (state === current) {
        state.checking = false;
        controls();
        if (state.returnToList) $('identify-cancel').focus();
        else if (!state.needsCheck) rows.querySelector('input').focus();
        else checkOutcome.focus();
      }
    }
  });

  $('identify-form').addEventListener('submit', async event => {
    event.preventDefault();
    const state = current;
    if (!state || state.sending || state.needsCheck) return;
    const ids = new Set();
    const distribution = [];
    for (const row of rows.children) {
      const id = row.querySelector('[name=beneficiaryId]');
      const amount = row.querySelector('[name=amount]');
      id.value = id.value.trim().toLowerCase();
      const units = minorUnits(amount.value);
      const number = units === null ? NaN : Number(decimal(units));
      id.setCustomValidity(!uuid.test(id.value) ? 'Введите UUID бенефициара.' :
        ids.has(id.value) ? 'Этот бенефициар уже есть в распределении.' : '');
      amount.setCustomValidity(units === null || units <= 0n || minorUnits(number) !== units ?
        'Введите положительную сумму с точностью до копеек.' : '');
      ids.add(id.value);
      distribution.push({ beneficiaryId: id.value, amount: number });
    }
    if (!$('identify-form').reportValidity()) return;
    if (distributed() !== state.total) {
      status(feedback, 'Сумма всех строк должна совпадать с суммой пополнения.', 'error');
      return;
    }

    state.sending = true;
    controls();
    status(feedback, 'Отправляем распределение…', 'loading');
    try {
      await request('/incoming-transactions/' + state.operationId + '/identify', {
        method: 'POST', body: { amountDistribution: distribution }, signal: state.abort.signal,
      });
    } catch (error) {
      if (state === current) {
        state.needsCheck = !error.status || [404, 408, 409].includes(error.status) || error.status >= 500;
        if (state.needsCheck) uncertain.add(state.operationId);
        const advice = state.needsCheck ? ' Перед повтором проверьте пополнение по ID.' : '';
        status(feedback, error.message + advice, 'error');
      }
      return;
    } finally {
      if (state === current) {
        state.sending = false;
        controls();
        if (state.needsCheck) checkOutcome.focus();
      }
    }
    if (state !== current) return;
    completed.add(state.operationId);
    close();
    onResult(state.operationId);
  });

  return {
    buttonFor,
    endSession() {
      completed.clear();
      uncertain.clear();
      close();
    },
  };
}
