import { formatAmount } from './amount.js';
import { listPage, setDisclosure } from './beneficiaries.js';
import { billingRecord, transfersPath } from './billing.js';
import { appendCopyId } from './copy-id.js';
import { initPagination, readPage } from './pagination.js';
import { insertExpandedRow, recordDetails, recordField, tableCell, tableHeaders } from './record-details.js';

const $ = id => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const labels = [
  ['transferId', 'ID перевода'], ['amount', 'Сумма'], ['type', 'Вид перевода'], ['purpose', 'Назначение'],
  ['accountNumber', 'Номинальный счёт'], ['dealId', 'ID сделки'], ['stepId', 'ID этапа'], ['name', 'ФИО / наименование'],
];
const sections = [
  { summary: true, keys: ['transferId', 'amount', 'type', 'accountNumber'] },
  { title: 'Данные перевода' },
];
export const transferColumns = ['ID перевода', 'Отправитель', 'Получатель', 'Сумма', 'Назначение'];
const transferTypes = new Map([['DIRECT', 'Прямой'], ['DEAL', 'По сделке']]);

export async function fetchTransfers(request, query, signal) {
  return listPage(await request(transfersPath, { query, signal }), ['transfers'], ['transferId']);
}

export async function fetchTransfer(request, id, signal) {
  const data = await request(transfersPath + '/' + id, { signal });
  const item = billingRecord(data, 'transferId', 'transfer');
  if (!item || String(item.transferId).toLowerCase() !== id.toLowerCase()) {
    throw new Error('Прокси вернул некорректные данные перевода.');
  }
  return item;
}

function partyIds(party) {
  const ids = typeof party === 'string' ? [party] : [party?.beneficiaryId];
  if (Array.isArray(party?.beneficiaryIds)) ids.push(...party.beneficiaryIds);
  return [...new Map(ids.filter(id => typeof id === 'string' && id.trim()).map(id => [id.toLowerCase(), id])).values()];
}

function participantDetails(party, title) {
  const section = document.createElement('section');
  section.className = 'record-section transfer-party';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);
  const ids = partyIds(party);
  for (const id of ids) {
    const fields = document.createElement('dl');
    fields.className = 'record-fields transfer-party-record';
    fields.append(recordField('beneficiaryId', 'ID бенефициара', id));
    section.append(fields);
  }
  if (party && typeof party === 'object') {
    const { beneficiaryId, beneficiaryIds, ...otherFields } = party;
    section.append(recordDetails(otherFields, labels, undefined, [{}]));
  }
  return section.childElementCount > 1 ? section : undefined;
}

export function transferDetails(item) {
  const { transferId, amount, type, from, to, ...rest } = item;
  const details = recordDetails({ transferId, amount: formatAmount(amount), type: transferTypes.get(type) ?? type, ...rest },
    labels, 'transferId', sections);
  const parties = [participantDetails(from, 'Отправитель'), participantDetails(to, 'Получатель')].filter(Boolean);
  details.querySelector('.record-summary').after(...parties);
  return details;
}

function partyCell(row, party) {
  const ids = partyIds(party);
  if (!ids.length) return tableCell(row, party?.name);
  const container = document.createElement('div');
  container.className = 'transfer-party-names';
  for (const id of ids) {
    const value = document.createElement('span');
    value.textContent = value.title = id;
    container.append(value);
  }
  return tableCell(row, container);
}

function setStatus(node, text, state = 'idle') {
  node.textContent = text;
  node.dataset.state = state;
}

export function appendTransferRow(row, item, open, inline = false) {
  const id = item.transferId;
  let value = id || null;
  if (uuid.test(id)) {
    value = document.createElement('button');
    value.type = 'button';
    value.className = 'link';
    value.textContent = id;
    if (inline) value.setAttribute('aria-expanded', 'false');
    value.addEventListener('click', () => open(id, value));
  }
  const idCell = tableCell(row, value);
  idCell.className = 'record-id';
  appendCopyId(idCell, id, 'ID перевода');
  partyCell(row, item.from);
  partyCell(row, item.to);
  tableCell(row, formatAmount(item.amount));
  tableCell(row, item.purpose);
}

export function initBeneficiaryTransfers(request) {
  const host = $('beneficiary-transfer-lists');
  let beneficiaryId;

  function createGroup(direction, title, filter) {
    const region = $('beneficiary-transfer-template').content.firstElementChild.cloneNode(true);
    const part = name => region.querySelector('[data-part="' + name + '"]');
    const heading = part('heading');
    heading.id = 'beneficiary-transfers-' + direction;
    part('title').textContent = title;
    const content = part('content');
    const toggle = part('toggle');
    content.id = heading.id + '-content';
    toggle.setAttribute('aria-controls', content.id);
    region.setAttribute('aria-labelledby', heading.id);
    host.append(region);
    const pagination = initPagination(part('pagination'), load, 10);
    part('pagination').querySelector('nav').setAttribute('aria-label', 'Страницы · ' + title);
    const tableHost = part('table');
    const feedback = part('status');
    const refresh = part('refresh');
    let page;
    let active;
    let expanded;

    function closeDetail(restoreFocus = false) {
      if (!expanded) return;
      const { controller, row, trigger } = expanded;
      expanded = undefined;
      controller.abort();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      row.remove();
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }

    function reset() {
      active?.abort();
      active = page = undefined;
      closeDetail();
      tableHost.replaceChildren();
      setStatus(feedback, '');
      pagination.setSizes([10, 25, 50]);
      pagination.render();
      pagination.updateControls(false);
      part('pagination').hidden = true;
      setDisclosure(toggle, content, false);
      refresh.disabled = false;
    }

    async function open(id, button) {
      if (active) return;
      if (expanded?.trigger === button) return closeDetail(true);
      closeDetail();
      const detail = $('beneficiary-transfer-detail-template').content.firstElementChild.cloneNode(true);
      const title = detail.querySelector('h4');
      const detailStatus = detail.querySelector('[data-part="detail-status"]');
      const data = detail.querySelector('[data-part="data"]');
      detail.id = heading.id + '-detail-' + id;
      title.id = detail.id + '-title';
      detail.setAttribute('aria-labelledby', title.id);
      detail.querySelector('[data-part="close"]').addEventListener('click', () => closeDetail(true));
      setStatus(detailStatus, 'Загружаем перевод…', 'loading');
      const row = insertExpandedRow(button.closest('tr'), detail);
      const controller = new AbortController();
      const { signal } = controller;
      expanded = { controller, row, trigger: button };
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-controls', detail.id);
      title.focus();
      try {
        const item = await fetchTransfer(request, id, signal);
        signal.throwIfAborted();
        data.replaceChildren(transferDetails(item));
        data.hidden = false;
        setStatus(detailStatus, '');
      } catch (error) {
        if (!signal.aborted) setStatus(detailStatus, error.message, 'error');
      }
    }

    async function load(offset = 0, limit = Number(pagination.limit.value)) {
      if (!beneficiaryId || active) return;
      const controller = new AbortController();
      const { signal } = controller;
      active = controller;
      const query = { [filter]: beneficiaryId, limit };
      setStatus(feedback, page ? '' : 'Загружаем переводы…', 'loading');
      pagination.updateControls(true);
      refresh.disabled = true;
      try {
        const result = await readPage(position => fetchTransfers(request, { ...query, offset: position }, signal),
          offset, limit, page, signal);
        if (result.rows !== page?.rows) {
          closeDetail();
          const table = document.createElement('table');
          table.classList.add('billing-table', 'transfers-table');
          tableHeaders(table, transferColumns);
          const body = table.createTBody();
          for (const item of result.rows) appendTransferRow(body.insertRow(), item, open, true);
          tableHost.replaceChildren(...(result.rows.length ? [table] : []));
        }
        page = result;
        pagination.render(page);
        part('pagination').hidden = !page.count && !page.offset;
        setStatus(feedback, page.count ? '' : title + ' переводы отсутствуют.');
      } catch (error) {
        if (!signal.aborted) {
          setStatus(feedback, error.message, 'error');
          if (page) pagination.limit.value = page.limit;
        }
      } finally {
        if (active === controller) {
          active = undefined;
          pagination.updateControls(false);
          refresh.disabled = false;
        }
      }
    }

    toggle.addEventListener('click', () => {
      setDisclosure(toggle, content, content.hidden);
      if (!content.hidden && !page) load();
    });
    refresh.addEventListener('click', () => load(page?.offset, page?.limit));
    reset();
    return { reset };
  }

  const groups = [createGroup('incoming', 'Входящие', 'toBeneficiaryId'),
    createGroup('outgoing', 'Исходящие', 'fromBeneficiaryId')];
  function reset() {
    beneficiaryId = undefined;
    groups.forEach(group => group.reset());
  }
  return {
    setBeneficiary(record) {
      const id = record.beneficiaryId.toLowerCase();
      if (id !== beneficiaryId) {
        reset();
        beneficiaryId = id;
      }
    },
    reset,
  };
}
