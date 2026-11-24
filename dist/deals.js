import { listPage } from './beneficiaries.js';
import { initStepParties } from './step-parties.js';
import { appendCopyId } from './copy-id.js';
import { insertExpandedRow, recordDetails, recordField, tableCell, tableHeaders } from './record-details.js';

const $ = id => document.getElementById(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const stepLimit = 50;
const maxOffset = 2147483647;
const statuses = new Map([
  ['DRAFT', ['Черновик', 'idle']],
  ['ACCEPTED', ['Подтверждена', 'success']],
  ['IN_PROGRESS', ['В процессе', 'loading']],
  ['COMPLETED', ['Завершено', 'success']],
  ['CANCELLED', ['Отменено', 'idle']],
  ['NEW', ['Новый', 'idle']],
  ['PAYMENT_IN_PROGRESS', ['Выплата в процессе', 'loading']],
  ['PAYMENT_FAILED', ['Ошибка выплаты', 'error']],
]);
const validationLabels = [
  ['dealId', 'ID сделки'], ['stepId', 'ID этапа'], ['beneficiaryId', 'ID бенефициара'],
  ['recipientId', 'ID реципиента'], ['required', 'Требуемая сумма'], ['available', 'Доступно'],
];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function dealStatus(code) {
  const [label, state] = statuses.get(code) ?? [code || '—', 'idle'];
  const badge = element('span', label, 'status-pill');
  badge.dataset.state = state;
  if (code) badge.title = code;
  return badge;
}

function status(id, message, state = 'idle') {
  $(id).textContent = message;
  $(id).dataset.state = state;
}

function detailGrid(id, fields) {
  $(id).replaceChildren(...fields.map(([key, label, value]) => recordField(key, label, value ?? '—')));
}

function record(data, field) {
  for (let depth = 0; depth < 8 && data != null; depth++) {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return undefined; }
      continue;
    }
    if (typeof data !== 'object' || Array.isArray(data)) return undefined;
    if (Object.hasOwn(data, field)) return data;
    data = data.deal ?? data.step ?? data.deponent ?? data.recipient ?? data.data ?? data.result ?? data.responseBody;
  }
  return undefined;
}

function sameId(left, right) {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

export function initDeals(request, refreshList, accountNumber, openPayments) {
  const dialog = $('deal-dialog');
  const panel = $('deal-panel');
  const stepList = $('step-list');
  const stepDetail = $('step-detail');
  const stepPanel = $('step-panel');
  let enabled = false;
  let active;
  let writing = false;
  let dealId;
  let deal;
  let step;
  let expandedStep;
  let stepOffset = 0;
  let hasMoreSteps = false;
  let returnFocus;
  let editor;

  const dealPath = () => '/deals/' + dealId;
  const stepsPath = () => dealPath() + '/steps';
  const parties = initStepParties({
    request, run, record, invalidateValidation: () => $('deal-validation').replaceChildren(),
  });

  function controls() {
    const busy = !enabled || Boolean(active);
    const draft = deal?.status === 'DRAFT';
    const accepted = deal?.status === 'ACCEPTED';
    const inProgress = deal?.status === 'IN_PROGRESS';
    for (const node of document.querySelectorAll('[data-deal-control], #step-list > table > tbody > tr:not(.expanded-row) button')) node.disabled = busy;
    $('deal-actions').hidden = $('deal-steps').hidden = !deal;
    $('deal-accept').hidden = $('deal-delete').hidden = $('step-create').hidden = !draft;
    $('deal-draft').hidden = !accepted;
    $('deal-cancel').hidden = !(draft || accepted || inProgress);
    $('step-edit').hidden = $('step-delete').hidden = !draft;
    const canComplete = accepted || inProgress || deal?.status === 'PAYMENT_FAILED';
    $('step-complete').hidden = !canComplete || !['NEW', 'PAYMENT_FAILED'].includes(step?.status);
    $('step-prev').disabled ||= !stepOffset;
    $('step-next').disabled ||= !hasMoreSteps;
    $('deal-back').disabled = $('deal-dialog-cancel').disabled = writing;
    $('deal-fields').disabled = $('deal-save').disabled = busy;
    parties.setBusy(busy, writing);
  }

  function closeEditor() {
    editor = undefined;
    $('deal-form').reset();
    status('deal-editor-status', '');
    if (dialog.open) dialog.close();
  }

  function closeStep() {
    parties.close();
    step = undefined;
    stepPanel.hidden = true;
    $('step-data').replaceChildren();
    status('step-status', '');
    if (!expandedStep) return;
    const { row, trigger } = expandedStep;
    expandedStep = undefined;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    $('step-pages').after(stepDetail);
    row.remove();
  }

  function expandStep(id) {
    const trigger = stepList.querySelector('[data-step-id="' + id.toLowerCase() + '"]');
    if (!trigger) return false;
    closeStep();
    expandedStep = { id, trigger, row: insertExpandedRow(trigger.closest('tr'), stepDetail) };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', stepDetail.id);
    return true;
  }

  function showStep(record) {
    step = record;
    stepPanel.hidden = false;
    $('step-title').textContent = step.stepNumber == null ? 'Этап сделки' : 'Этап ' + step.stepNumber;
    detailGrid('step-data', [
      ['stepId', 'ID этапа', step.stepId], ['status', 'Статус', dealStatus(step.status)],
      ['description', 'Описание', step.description],
    ]);
    controls();
  }

  function close(restoreFocus = false) {
    active?.abort();
    active = undefined;
    writing = false;
    if (!panel.hidden) {
      panel.hidden = true;
      $('list-panel').hidden = false;
    }
    const trigger = returnFocus;
    returnFocus = dealId = deal = undefined;
    stepOffset = 0;
    hasMoreSteps = false;
    closeEditor();
    closeStep();
    for (const id of ['deal-data', 'deal-validation', 'step-list']) $(id).replaceChildren();
    for (const id of ['deal-status', 'step-list-status', 'deal-list-feedback']) status(id, '');
    status('deal-search-status', '');
    $('step-pages').hidden = true;
    controls();
    if (restoreFocus) (trigger?.isConnected ? trigger : $('results-title')).focus();
  }

  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    if (enabled) controls();
    else close();
  }

  async function run(target, action, mutation = false) {
    if (!enabled || active) return;
    const controller = new AbortController();
    active = controller;
    writing = mutation;
    status(target, mutation ? 'Отправляем запрос…' : 'Загружаем данные…', 'loading');
    controls();
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) status(target, error.message, 'error');
    } finally {
      if (active === controller) {
        active = undefined;
        writing = false;
        controls();
      }
    }
  }

  async function readStep(id, signal) {
    const item = record(await request(stepsPath() + '/' + id, { signal }), 'stepId');
    signal.throwIfAborted();
    if (!sameId(item?.stepId, id) || !sameId(item.dealId, dealId)) {
      throw new Error('Прокси вернул данные другого этапа или сделки.');
    }
    showStep(item);
    await parties.show({
      path: stepsPath() + '/' + id, dealId, stepId: id, draft: deal.status === 'DRAFT',
      repair: item.status === 'PAYMENT_FAILED' || deal.status === 'PAYMENT_FAILED',
    }, signal);
    signal.throwIfAborted();
  }

  function openStep(id) {
    if (!enabled || active) return;
    if (sameId(expandedStep?.id, id)) {
      closeStep();
      return;
    }
    if (!expandStep(id)) return;
    run('step-status', async signal => {
      await readStep(id, signal);
      status('step-status', '');
      $('step-title').focus();
    });
  }

  async function readSteps(offset, signal, createdStepId) {
    const read = async position => listPage(
      await request(stepsPath(), { query: { offset: position, limit: stepLimit }, signal }),
      ['steps'], ['stepId', 'stepNumber'],
    );
    let { rows, total } = await read(offset);
    if (!rows.length && offset) {
      offset = total === undefined ? offset - stepLimit : Math.max(0, Math.ceil(total / stepLimit) - 1) * stepLimit;
      ({ rows, total } = await read(offset));
    }
    if (createdStepId && total && !rows.some(item => sameId(item.stepId, createdStepId))) {
      const lastOffset = Math.floor((total - 1) / stepLimit) * stepLimit;
      if (lastOffset > offset && lastOffset <= maxOffset) {
        const last = await read(lastOffset);
        if (last.rows.some(item => sameId(item.stepId, createdStepId))) {
          ({ rows, total } = last);
          offset = lastOffset;
        }
      }
    }
    signal.throwIfAborted();
    if (rows.some(item => item.dealId != null && !sameId(item.dealId, dealId))) {
      throw new Error('Прокси вернул этапы другой сделки.');
    }
    const table = element('table');
    tableHeaders(table, ['№', 'Описание', 'Статус', 'ID этапа']);
    const body = table.createTBody();
    for (const item of rows) {
      const tr = body.insertRow();
      tableCell(tr, item.stepNumber);
      const label = item.description || 'Открыть этап';
      if (uuid.test(item.stepId)) {
        const link = element('button', label, 'link');
        link.type = 'button';
        link.dataset.stepId = item.stepId.toLowerCase();
        link.setAttribute('aria-expanded', 'false');
        link.addEventListener('click', () => openStep(item.stepId));
        tableCell(tr, link);
      } else tableCell(tr, label);
      tableCell(tr, dealStatus(item.status));
      const idCell = tableCell(tr, item.stepId);
      idCell.className = 'record-id';
      appendCopyId(idCell, item.stepId, 'ID этапа');
    }
    stepOffset = offset;
    hasMoreSteps = offset + stepLimit <= maxOffset &&
      (total === undefined ? rows.length === stepLimit : offset + stepLimit < total);
    closeStep();
    stepList.replaceChildren(...(rows.length ? [table] : []));
    $('step-pages').hidden = !(offset || hasMoreSteps);
    $('step-count').textContent = total === undefined ? '' : 'Всего этапов ' + total.toLocaleString('ru-RU');
    status('step-list-status', rows.length ? '' : 'У сделки пока нет этапов.');
  }

  async function fetchDeal(id, signal) {
    const item = record(await request('/deals/' + id, { signal }), 'dealId');
    if (!sameId(item?.dealId, id)) throw new Error('Прокси вернул данные другой сделки.');
    return item;
  }

  async function renderCard(item, signal, { stepId, created = false } = {}) {
    deal = item;
    detailGrid('deal-data', [
      ['dealId', 'ID сделки', deal.dealId], ['accountNumber', 'Номинальный счёт', deal.accountNumber],
      ['status', 'Статус', dealStatus(deal.status)],
    ]);
    controls();
    status('step-list-status', 'Загружаем этапы…', 'loading');
    try {
      await readSteps(stepOffset, signal, created ? stepId : undefined);
    } catch (error) {
      signal.throwIfAborted();
      status('step-list-status', error.message, 'error');
    }
    if (stepId && expandStep(stepId)) {
      try {
        await readStep(stepId, signal);
      } catch (error) {
        signal.throwIfAborted();
        status('step-status', error.message, 'error');
      }
    }
  }

  async function readCard(signal, selection) {
    await renderCard(await fetchDeal(dealId, signal), signal, selection);
  }

  function showCard(id, trigger) {
    dealId = id;
    returnFocus = trigger;
    $('list-panel').hidden = true;
    panel.hidden = false;
    $('deal-title').focus();
  }

  function open(id, trigger) {
    if (!enabled || active) return;
    close();
    run('deal-search-status', async signal => {
      id = id.trim().toLowerCase();
      if (!uuid.test(id)) throw new Error('Введите ID сделки в формате UUID.');
      const item = await fetchDeal(id, signal);
      status('deal-search-status', '');
      showCard(id, trigger);
      await renderCard(item, signal);
    });
  }

  function refreshCard(signal) {
    const stepId = expandedStep?.id;
    $('deal-validation').replaceChildren();
    status('step-status', '');
    return readCard(signal, { stepId });
  }

  async function refreshAfterChange(target, message, signal, selection) {
    deal = undefined;
    closeStep();
    $('deal-validation').replaceChildren();
    $('deal-data').replaceChildren();
    stepList.replaceChildren();
    $('step-pages').hidden = true;
    for (const id of ['deal-status', 'step-list-status']) status(id, '');
    controls();
    refreshList();
    try {
      await readCard(signal, selection);
      status(target, message, 'success');
    } catch (error) {
      signal.throwIfAborted();
      status('deal-status', message + ' Не удалось обновить карточку. ' + error.message, 'error');
    }
  }

  function validate() {
    run('deal-status', async signal => {
      $('deal-validation').replaceChildren();
      const result = record(await request(dealPath() + '/is-valid', { signal }), 'isValid');
      if (typeof result?.isValid !== 'boolean') throw new Error('Не удалось прочитать результат проверки сделки.');
      status('deal-status', '');
      const notice = $('deal-validation');
      notice.dataset.state = result.isValid ? 'success' : 'error';
      const summary = element('div', null, 'notice-summary');
      summary.append(element('strong', result.isValid ? 'Выплаты возможны' : 'Проверка выплат не пройдена'));
      notice.append(summary);
      if (Array.isArray(result.reasons) && result.reasons.length) {
        const details = element('div', null, 'notice-details');
        const issues = element('div', null, 'notice-issues');
        const list = element('ul');
        for (const reason of result.reasons) {
          const item = element('li');
          const description = typeof reason === 'string' ? reason : reason?.description;
          if (description) item.append(element('span', description));
          if (reason?.code) item.append(element('code', reason.code));
          if (reason?.details && typeof reason.details === 'object') {
            item.append(recordDetails(reason.details, validationLabels, undefined, [{}]));
          } else if (reason?.details) item.append(element('p', reason.details));
          list.append(item);
        }
        issues.append(list);
        details.append(issues);
        notice.append(details);
      }
    });
  }

  function edit(kind) {
    const creatingDeal = kind === 'deal';
    const editingStep = kind === 'edit-step';
    if (!enabled || active || (!creatingDeal && deal?.status !== 'DRAFT') || (editingStep && !step)) return;
    editor = { kind };
    $('deal-editor-title').textContent = creatingDeal ? 'Создать сделку' : editingStep ? 'Редактировать этап' : 'Добавить этап';
    const account = $('deal-account');
    const description = $('step-description');
    account.parentElement.hidden = account.disabled = !creatingDeal;
    description.parentElement.hidden = description.disabled = creatingDeal;
    account.value = creatingDeal ? accountNumber() ?? '' : '';
    description.value = editingStep ? step.description ?? '' : '';
    status('deal-editor-status', '');
    dialog.showModal();
    (creatingDeal ? account : description).focus();
  }

  async function save(signal) {
    const { kind } = editor;
    const creatingDeal = kind === 'deal';
    const editingStep = kind === 'edit-step';
    const stepId = editingStep ? step.stepId : undefined;
    const body = creatingDeal ? { accountNumber: $('deal-account').value.trim() } : { description: $('step-description').value.trim() };
    if (!creatingDeal && body.description.length < 3) throw new Error('Введите описание этапа длиной от 3 символов.');
    const path = creatingDeal ? '/deals' : stepsPath() + (stepId ? '/' + stepId : '');
    const data = await request(path, { method: editingStep ? 'PUT' : 'POST', body, idempotent: !editingStep, signal });
    closeEditor();
    if (creatingDeal) {
      const id = record(data, 'dealId')?.dealId;
      if (uuid.test(id)) {
        showCard(id, $('deal-create'));
        await refreshAfterChange('deal-status', 'Сделка создана.', signal);
      } else {
        refreshList();
        status('deal-list-feedback', 'Сделка создана. Найдите её в обновлённом списке.', 'success');
      }
    } else {
      const id = record(data, 'stepId')?.stepId ?? stepId;
      await refreshAfterChange('step-status', editingStep ? 'Этап обновлён.' : 'Этап добавлен.', signal, {
        stepId: uuid.test(id) ? id : undefined, created: !editingStep,
      });
    }
  }

  function changeDeal(suffix, method, question, message) {
    if (!deal || active || !confirm(question + '\nID сделки ' + dealId)) return;
    run('deal-status', async signal => {
      await request(dealPath() + suffix, { method, signal });
      if (method === 'DELETE') {
        close(true);
        refreshList();
        status('deal-list-feedback', message, 'success');
      } else await refreshAfterChange('deal-status', message, signal);
    }, true);
  }

  function changeStep(method, question, message) {
    if (!step || active || !confirm(question + '\nID этапа ' + step.stepId)) return;
    const id = step.stepId;
    run('step-status', async signal => {
      await request(stepsPath() + '/' + id + (method === 'POST' ? '/complete' : ''), { method, signal });
      await refreshAfterChange('step-status', message, signal, { stepId: method === 'POST' ? id : undefined });
    }, true);
  }

  $('deal-search').addEventListener('submit', event => {
    event.preventDefault();
    open($('deal-search-id').value, event.submitter);
  });
  $('deal-create').addEventListener('click', () => edit('deal'));
  $('step-create').addEventListener('click', () => edit('new-step'));
  $('step-edit').addEventListener('click', () => edit('edit-step'));
  $('step-payments').addEventListener('click', () => openPayments(dealId));
  $('deal-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editor) run('deal-editor-status', save, true);
  });
  $('deal-dialog-cancel').addEventListener('click', closeEditor);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!writing) closeEditor();
  });
  $('deal-back').addEventListener('click', () => close(true));
  $('deal-refresh').addEventListener('click', () => run('deal-status', async signal => {
    await refreshCard(signal);
    status('deal-status', '');
  }));
  $('step-prev').addEventListener('click', () => run('step-list-status', signal => readSteps(Math.max(0, stepOffset - stepLimit), signal)));
  $('step-next').addEventListener('click', () => run('step-list-status', signal => readSteps(stepOffset + stepLimit, signal)));
  $('deal-validate').addEventListener('click', validate);
  $('deal-accept').addEventListener('click', () => changeDeal('/accept', 'POST', 'Подтвердить параметры сделки?', 'Параметры сделки подтверждены.'));
  $('deal-draft').addEventListener('click', () => changeDeal('/draft', 'POST', 'Перевести сделку в черновик?', 'Сделка переведена в черновик.'));
  $('deal-cancel').addEventListener('click', () => changeDeal('/cancel', 'POST', 'Отменить сделку?', 'Сделка отменена.'));
  $('deal-delete').addEventListener('click', () => changeDeal('', 'DELETE', 'Удалить сделку?', 'Сделка удалена.'));
  $('step-delete').addEventListener('click', () => changeStep('DELETE', 'Удалить этап сделки?', 'Этап удалён.'));
  $('step-complete').addEventListener('click', () => changeStep('POST', 'Завершить этап сделки? Запрос может запустить выплаты реципиентам.', 'Запрос на завершение этапа принят.'));
  window.addEventListener('beforeunload', event => {
    if (writing) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  return { open, setEnabled, close, get canLeave() { return !writing; } };
}
