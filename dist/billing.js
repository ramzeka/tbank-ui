import { decimal, minorUnits } from './amount.js';
import { beneficiaryName, fetchBeneficiary, listPage } from './beneficiaries.js';
import { bankTypes } from './beneficiary-schema.js';

export function paymentFailureReason(item) {
  if (item.status !== 'FAILED') return '';
  const code = item.errorCode;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code)
    ? 'Код ' + code
    : 'Платёж не исполнен. Для уточнения используйте ID платежа.';
}

const $ = id => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const transfersPath = '/virtual-accounts/transfers';

export function billingRecord(data, key, wrapper) {
  for (let depth = 0; depth < 8 && data != null; depth++) {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { break; }
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) break;
    if (Object.hasOwn(data, key)) return data;
    data = data[wrapper] ?? data.data ?? data.result ?? data.responseBody ?? data.body ?? data.payload ?? data.response ?? data.value;
  }
}

export function initBillingEditor({ request, accountNumber, onCreated }) {
  const dialog = $('billing-dialog');
  const form = $('billing-form');
  const from = $('billing-from');
  const to = $('billing-to');
  const bank = $('billing-bank');
  const purpose = $('billing-purpose');
  let kind;
  let active;
  let sending = false;
  let bankOwner;

  function status(id, text, state = 'idle') {
    $(id).textContent = text;
    $(id).dataset.state = state;
  }

  function controls() {
    $('billing-fields').disabled = Boolean(active);
    $('billing-submit').disabled = Boolean(active) || (kind === 'payment' && !bank.value);
    $('billing-cancel').disabled = sending;
  }

  function clearBanks() {
    bankOwner = undefined;
    bank.replaceChildren(new Option('Выберите реквизиты', ''));
    status('billing-bank-status', '');
  }

  function close() {
    active?.abort();
    active = undefined;
    sending = false;
    form.reset();
    clearBanks();
    status('billing-status', '');
    dialog.close();
  }

  function open(value) {
    if (dialog.open) return;
    kind = value;
    const payment = kind === 'payment';
    form.reset();
    clearBanks();
    $('billing-account').value = accountNumber() ?? '';
    $('billing-title').textContent = payment ? 'Создать платёж' : 'Создать перевод';
    $('billing-from-label').textContent = payment ? 'ID бенефициара' : 'ID отправителя';
    to.disabled = to.parentElement.hidden = payment;
    bank.disabled = !payment;
    $('billing-bank-label').hidden = $('billing-bank-controls').hidden = $('billing-bank-status').hidden = !payment;
    purpose.required = payment;
    $('billing-submit').textContent = payment ? 'Создать платёж' : 'Создать перевод';
    status('billing-status', '');
    controls();
    dialog.showModal();
  }

  function beneficiaryId(input, label) {
    const id = input.value.trim().toLowerCase();
    if (!uuid.test(id)) throw new Error('Укажите ' + label + ' в формате UUID.');
    return id;
  }

  async function run(action, write = false, statusId = 'billing-status') {
    if (active || !dialog.open) return;
    const controller = new AbortController();
    active = controller;
    sending = write;
    controls();
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) status(statusId, error.message, 'error');
    } finally {
      if (active === controller) {
        active = undefined;
        sending = false;
        controls();
      }
    }
  }

  async function loadBanks(signal) {
    clearBanks();
    const id = beneficiaryId(from, 'ID бенефициара');
    status('billing-bank-status', 'Загружаем реквизиты…', 'loading');
    const beneficiary = await fetchBeneficiary(request, id, signal);
    const options = new Map();
    let preferred;
    for (let offset = 0; offset <= 2147483647;) {
      const data = await request('/beneficiaries/' + id + '/bank-details', { query: { offset, limit: 50 }, signal });
      const { rows, total } = listPage(data, ['bankDetails', 'requisites'], ['bankDetailsId', 'accountNumber', 'cardId']);
      let added = 0;
      for (const item of rows) {
        const bankId = item.bankDetailsId ?? item.id;
        if (!uuid.test(bankId) || options.has(bankId)) continue;
        const masked = item.accountNumber ?? item.cardId ?? item.phoneNumber;
        const label = [bankTypes[item.type] ?? item.type, item.bankName, masked && '…' + String(masked).slice(-4),
          item.isDefault && 'По умолчанию'].filter(Boolean).join(' · ');
        options.set(bankId, new Option(label || bankId, bankId));
        if (item.isDefault) preferred = bankId;
        added++;
      }
      offset += rows.length;
      if (!added || (total === undefined ? rows.length < 50 : offset >= total)) break;
    }
    signal.throwIfAborted();
    bankOwner = id;
    bank.append(...options.values());
    bank.value = preferred ?? (options.size === 1 ? options.keys().next().value : '');
    status('billing-bank-status', options.size ? beneficiaryName(beneficiary) : 'У бенефициара нет реквизитов.');
  }

  async function save(signal) {
    const payment = kind === 'payment';
    const sender = beneficiaryId(from, payment ? 'ID бенефициара' : 'ID отправителя');
    const account = $('billing-account').value;
    const units = minorUnits($('billing-amount').value);
    const amount = units == null ? NaN : Number(decimal(units));
    if (units == null || units <= 0n || minorUnits(amount) !== units) throw new Error('Введите положительную сумму с точностью до копеек.');
    const description = purpose.value.trim();
    if (payment && !description) throw new Error('Укажите назначение платежа.');
    const body = { accountNumber: account, amount };
    if (description) body.purpose = description;
    let target;
    if (payment) {
      if (sender !== bankOwner || !uuid.test(bank.value)) throw new Error('Загрузите и выберите реквизиты бенефициара.');
      Object.assign(body, { type: 'REGULAR', beneficiaryId: sender, bankDetailsId: bank.value });
      target = bank.selectedOptions[0].text;
    } else {
      const recipient = beneficiaryId(to, 'ID получателя');
      if (recipient === sender) throw new Error('Выберите разных бенефициаров для отправителя и получателя.');
      Object.assign(body, { from: { beneficiaryId: sender }, to: { beneficiaryId: recipient } });
      target = recipient;
    }
    if (!confirm((payment ? 'Создать платёж' : 'Создать перевод') + ' на ' + decimal(units) + ' ₽?\n' +
      'Номинальный счёт: ' + account + '\nОтправитель: ' + sender + '\nПолучатель: ' + target)) return;
    const path = payment ? '/payments' : transfersPath;
    status('billing-status', 'Отправляем запрос…', 'loading');
    const data = await request(path, { method: 'POST', body, idempotent: true, signal });
    signal.throwIfAborted();
    const record = billingRecord(data, kind + 'Id', kind);
    close();
    onCreated(payment, record?.[payment ? 'paymentId' : 'transferId']);
  }

  from.addEventListener('input', () => { clearBanks(); controls(); });
  bank.addEventListener('change', controls);
  $('billing-bank-load').addEventListener('click', () => run(loadBanks, false, 'billing-bank-status'));
  $('billing-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!sending) close(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    status('billing-status', '');
    run(save, true);
  });
  window.addEventListener('beforeunload', event => {
    if (sending) { event.preventDefault(); event.returnValue = ''; }
  });
  return { open, close, get writing() { return sending; } };
}
