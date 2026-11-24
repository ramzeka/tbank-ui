import { balanceTable, beneficiaryName, fetchBalancePage, fetchBeneficiary } from './beneficiaries.js';
import { beneficiaryTypes } from './beneficiary-schema.js';

const $ = id => document.getElementById(id);

// Store minor units so distributions such as 0.10 + 0.20 compare exactly.
function minorUnits(value) {
  const text = String(value ?? '').trim();
  const parts = /^(\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!parts) return null;
  const whole = parts[1].replace(/[ \u00a0\u202f]/g, '');
  if (whole.length > 16) return null;
  return BigInt(whole) * 100n + BigInt((parts[2] ?? '').padEnd(2, '0'));
}

function decimal(units) {
  const n = units < 0n ? -units : units;
  return (units < 0n ? '-' : '') + String(n / 100n) + '.' + String(n % 100n).padStart(2, '0');
}

function display(units, currency) {
  return decimal(units).replace('.', ',') + (currency ? ' ' + currency : '');
}

function bindRecipientCheck(row, request, uuid, sessionSignal) {
  const input = row.querySelector('[name=beneficiaryId]');
  const check = row.querySelector('.recipient-check');
  const preview = row.querySelector('.recipient-preview');
  const info = row.querySelector('.recipient-info');
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
    balances.replaceChildren();
    more.hidden = true;
  }

  async function showInfo(id, signal) {
    try {
      const record = await fetchBeneficiary(request, id, signal);
      if (signal.aborted) return;
      const name = document.createElement('strong');
      name.textContent = beneficiaryName(record);
      info.replaceChildren(name);
      const type = beneficiaryTypes[record.type] ?? record.type;
      const fields = [type !== name.textContent && type, record.inn && 'ИНН ' + record.inn].filter(Boolean);
      if (fields.length) {
        const details = document.createElement('p');
        details.textContent = fields.join(' · ');
        info.append(details);
      }
    } catch (error) {
      if (signal.aborted) return;
      info.dataset.state = 'error';
      info.textContent = 'Данные бенефициара. ' + error.message;
    }
  }

  async function showBalances(id, signal) {
    more.disabled = true;
    balanceStatus.dataset.state = 'loading';
    balanceStatus.textContent = 'Загружаем остатки…';
    try {
      const page = await fetchBalancePage(request, id, balanceRows.length, signal);
      if (signal.aborted) return;
      balanceRows.push(...page.rows);
      if (balanceRows.length) balances.replaceChildren(balanceTable(balanceRows, { hideBeneficiaryId: true }));
      balanceStatus.dataset.state = 'success';
      balanceStatus.textContent = balanceRows.length ? '' : 'Данных об остатках нет.';
      more.hidden = !page.hasMore;
    } catch (error) {
      if (signal.aborted) return;
      balanceStatus.dataset.state = 'error';
      balanceStatus.textContent = error.message;
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
    info.dataset.state = 'loading';
    info.textContent = 'Загружаем данные бенефициара…';
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

export function initIdentification(request, uuid, onSuccess) {
  const dialog = $('identify-dialog');
  const rows = $('distribution-rows');
  const completed = new Set();
  let current;
  let parked;

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
    rows.replaceChildren();
  }

  function open(item, total) {
    const operationId = item.operationId;
    if (current || completed.has(operationId)) return;
    current = { operationId, total, currency: item.currency ?? item.operationCurrency ?? '', abort: new AbortController(), sending: false };
    $('identify-operation').textContent = operationId;
    $('identify-payment').textContent = [item.payerName, display(total, current.currency)].filter(Boolean).join(' · ');
    $('identify-status').textContent = '';
    $('identify-fields').disabled = false;
    $('identify-submit').disabled = false;
    $('identify-cancel').disabled = false;
    if (parked?.operationId === operationId && parked.total === total) {
      for (const row of parked.rows) addRow(row.beneficiaryId, row.amount);
    } else {
      addRow('', decimal(total).replace('.', ','));
    }
    parked = undefined;
    dialog.showModal();
    rows.querySelector('input').focus();
  }

  function buttonFor(item) {
    const total = minorUnits(item.amount ?? item.operationAmount);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary transaction-identify';
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
    $('identify-status').textContent = '';
    updateTotals();
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!current?.sending) close();
  });
  $('identify-cancel').addEventListener('click', close);

  $('identify-form').addEventListener('submit', async event => {
    event.preventDefault();
    const state = current;
    if (!state || state.sending) return;
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
      $('identify-status').textContent = 'Сумма всех строк должна совпадать с суммой пополнения.';
      return;
    }

    state.sending = true;
    $('identify-fields').disabled = true;
    $('identify-submit').disabled = true;
    $('identify-cancel').disabled = true;
    $('identify-status').textContent = 'Отправляем распределение…';
    try {
      await request('/incoming-transactions/' + state.operationId + '/identify', {
        method: 'POST', body: { amountDistribution: distribution }, signal: state.abort.signal,
      });
    } catch (error) {
      if (state === current) $('identify-status').textContent = error.message;
      return;
    } finally {
      if (state === current) {
        state.sending = false;
        $('identify-fields').disabled = false;
        $('identify-submit').disabled = false;
        $('identify-cancel').disabled = false;
      }
    }
    if (state !== current) return;
    completed.add(state.operationId);
    close();
    onSuccess(state.operationId);
  });

  return {
    buttonFor,
    endSession(keepDraft) {
      if (current && keepDraft) parked = { operationId: current.operationId, total: current.total, rows: values() };
      if (!keepDraft) parked = undefined;
      completed.clear();
      close();
    },
  };
}
