import { dashboardMoney, loadDashboardIncoming, loadDashboardStatement } from './dashboard-data.js';
import { tableCell, tableHeaders } from './record-details.js';

const count = new Intl.NumberFormat('ru-RU');
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, action, className = 'link') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function notice(text, state = 'idle') {
  const node = element('p', 'dashboard-note', text);
  node.dataset.state = state;
  return node;
}

function dateLabel(day) {
  return shortDate.format(new Date(day + 'T00:00:00Z')).replace('.', '');
}

function operationDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateLabel(value) : dateTime.format(date);
}

function stat(label, value, detail, state) {
  const node = element('div', 'dashboard-card dashboard-stat');
  node.append(element('p', 'dashboard-note', label), element('strong', 'dashboard-value', value), notice(detail, state));
  return node;
}

function panel(title, content, action, figure = false) {
  const node = element(figure ? 'figure' : 'section', 'dashboard-card dashboard-panel');
  const head = element(figure ? 'figcaption' : 'div', 'dashboard-panel-heading');
  head.append(element('h2', '', title));
  if (action) head.append(action);
  node.append(head, content);
  return node;
}

function table(columns, rows, label) {
  const host = element('div', 'table-scroll dashboard-table-scroll');
  const node = element('table', 'dashboard-table');
  node.setAttribute('aria-label', label);
  tableHeaders(node, columns);
  const body = node.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    values.forEach(value => tableCell(row, value));
  }
  host.append(node);
  return host;
}

function graphFrame(scale, plot, ticks) {
  const frame = element('div', 'dashboard-chart');
  const axis = element('div', 'dashboard-axis');
  axis.setAttribute('aria-hidden', 'true');
  axis.append(...scale.map(value => element('span', '', value)));
  const dates = element('div', 'dashboard-ticks');
  dates.setAttribute('aria-hidden', 'true');
  dates.append(...ticks.map(value => element('span', '', value)));
  frame.append(axis, plot, dates);
  return frame;
}

function flowChart(data) {
  if (!data.complete) return notice('В выписке не хватает дат или сумм для построения графика.');
  const { timeline, currency } = data;
  const length = timeline.length > 7 ? 5 : 1;
  const buckets = [];
  for (let index = 0; index < timeline.length; index += length) {
    const days = timeline.slice(index, index + length);
    buckets.push({
      label: days.length === 1 ? dateLabel(days[0].day) : dateLabel(days[0].day) + ' — ' + dateLabel(days.at(-1).day),
      tick: dateLabel(days[0].day),
      credit: days.reduce((sum, day) => sum + day.credit, 0n),
      debit: days.reduce((sum, day) => sum + day.debit, 0n),
    });
  }
  const peak = Math.max(0, ...buckets.flatMap(bucket => [Number(bucket.credit), Number(bucket.debit)]));
  const order = 10 ** Math.floor(Math.log10(Math.max(100, peak / 3)));
  const step = [1, 2, 2.5, 5, 10].find(value => value * order * 3 >= peak) * order;
  const plot = element('div', 'dashboard-plot dashboard-columns');
  const detail = notice('');
  detail.classList.add('dashboard-chart-detail');
  detail.setAttribute('aria-live', 'polite');
  plot.style.setProperty('--bucket-count', buckets.length);
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', 'Движение денег по периодам');
  plot.append(...buckets.map(bucket => {
    const description = `${bucket.label} · Поступления ${dashboardMoney(bucket.credit, currency)} · Списания ${dashboardMoney(bucket.debit, currency)}`;
    const group = button('', () => {
      plot.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      group.setAttribute('aria-pressed', 'true');
      detail.textContent = description;
    }, 'dashboard-column');
    group.setAttribute('aria-pressed', 'false');
    group.setAttribute('aria-label', description);
    group.title = description;
    for (const kind of ['credit', 'debit']) {
      const bar = element('span', 'dashboard-' + kind);
      bar.style.height = `${100 * Number(bucket[kind]) / (3 * step)}%`;
      group.append(bar);
    }
    return group;
  }));
  const frame = graphFrame([3, 2, 1, 0].map(tick => compact.format(tick * step / 100)), plot, buckets.map(bucket => bucket.tick));
  frame.style.setProperty('--bucket-count', buckets.length);
  const host = element('div', 'dashboard-flow');
  const legend = element('div', 'dashboard-legend');
  for (const [kind, label] of [['credit', 'Поступления'], ['debit', 'Списания']]) {
    const entry = element('span');
    entry.append(element('i', 'dashboard-' + kind), document.createTextNode(label));
    legend.append(entry);
  }
  legend.append(element('span', '', (length === 1 ? 'По дням' : 'По 5 дней') + ' · ' + (currency === 'RUB' ? '₽' : currency)));
  host.append(legend, frame, detail);
  plot.lastElementChild.click();
  return host;
}

export function initDashboard(root, { request, readIncoming, navigate }) {
  const part = name => root.querySelector(`[data-dashboard="${name}"]`);
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const periods = [...root.querySelectorAll('[data-period]')];
  const refresh = part('refresh');
  const accountLabel = part('account');
  const incomingLink = part('incoming-link');
  const entries = new Map();
  let view = 'support';
  let days = 7;
  let account;
  let enabled = false;

  function renderIncoming(data) {
    const host = part('support-content');
    host.replaceChildren();
    if (!data) return;
    const { page, totals, counts, truncated } = data;
    const amounts = totals === null ? 'Недоступна' :
      [...totals].map(([currency, units]) => dashboardMoney(units, currency)).join(' · ') || dashboardMoney(0n, 'RUB');
    const countLabel = page.total === undefined ? count.format(page.count) + ' загружено' :
      count.format(page.total) + ' всего';
    const summary = element('div', 'dashboard-panel-heading');
    const amount = element('div');
    amount.append(notice(truncated ? 'Сумма загруженных пополнений' : 'Общая сумма'), element('strong', 'dashboard-value', amounts));
    summary.append(amount, notice(countLabel));
    host.append(summary);
    if (!page.count) {
      host.append(notice(truncated ? 'Банк не вернул записи пополнений.' : 'Неидентифицированных пополнений нет.'));
      return;
    }
    const rows = counts.map(([day, value]) => [day ? fullDate.format(new Date(day + 'T00:00:00Z')) : 'Дата не указана', count.format(value)]);
    host.append(table(['Дата (МСК)', 'Количество'], rows, 'Неидентифицированные пополнения по датам'));
  }

  function renderFinance(data) {
    const host = part('finance-content');
    host.replaceChildren();
    if (!data) return;
    const { timeline, credit, debit, currency, recent, truncated } = data;
    const period = `${dateLabel(timeline[0].day)} — ${dateLabel(timeline.at(-1).day)}`;
    const detail = truncated ? 'По загруженным операциям' : period;
    const stats = element('div', 'dashboard-stats');
    stats.append(
      stat('Поступления', dashboardMoney(credit, currency), detail),
      stat('Списания', dashboardMoney(debit, currency), detail),
    );
    const rows = recent.map(row => {
      const value = dashboardMoney(row.units, currency);
      const sum = row.units === null || !['credit', 'debit'].includes(row.kind) ? value : (row.kind === 'credit' ? '+' : '−') + value;
      const amount = element('span', 'dashboard-amount', sum);
      if (row.kind === 'credit') amount.dataset.state = 'success';
      return [operationDate(row.date), row.party, row.purpose, amount];
    });
    const recentTable = rows.length ? table(['Дата (МСК)', 'Контрагент', 'Назначение', 'Сумма'], rows, 'Последние проведённые операции') :
      notice('За выбранный период проведённых операций нет.');
    host.append(stats, panel('Движение денег', flowChart(data), null, true),
      panel('Последние операции', recentTable, button('К выписке', () => navigate('statement'))));
  }

  function updateTabs() {
    tabs.forEach(tab => {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    periods.forEach(item => item.setAttribute('aria-pressed', String(Number(item.dataset.period) === days)));
  }

  const selectedKey = () => view === 'support' ? 'incoming' : days;
  const canLoad = () => enabled && (view === 'support' ? /^(?:\d{20}|\d{22})$/.test(account) : /^\d{20}$/.test(account));

  function render() {
    const ready = canLoad();
    const entry = entries.get(selectedKey());
    const status = part('status');
    refresh.disabled = !ready || Boolean(entry?.controller);
    incomingLink.disabled = Boolean(entry?.controller);
    part('periods').hidden = !ready || view !== 'finance';
    accountLabel.hidden = !enabled || !account;
    accountLabel.textContent = enabled && account ? 'Счёт •• ' + account.slice(-4) : '';
    part('support').hidden = !ready || view !== 'support';
    part('finance').hidden = !ready || view !== 'finance';
    status.textContent = !enabled ? 'Войдите в настройках подключения, чтобы загрузить обзор.' :
      !account ? 'Укажите номер номинального счёта в настройках подключения.' :
      !ready ? 'Для выписки нужен 20-значный номер счёта.' :
      entry?.error ? entry.error + (entry.data ? ' Показаны данные последней успешной загрузки.' : '') :
      entry?.controller ? view === 'support' ? 'Загружаем пополнения…' : 'Загружаем выписку…' : '';
    if (entry?.data?.truncated) {
      const { page } = entry.data;
      const detail = view === 'support' ? page.total === undefined ?
        `Загружено ${count.format(page.count)} пополнений. Общая сумма и полная разбивка по датам недоступны.` :
        `Загружено ${count.format(page.count)} из ${count.format(page.total)} пополнений. Общая сумма и полная разбивка по датам недоступны.` :
        'Банк вернул только часть операций. Показатели рассчитаны по загруженным данным.';
      status.textContent = [status.textContent, detail].filter(Boolean).join(' ');
    }
    status.dataset.state = entry?.error ? 'error' : 'idle';
    status.hidden = !status.textContent;
    if (!ready) return;
    if (view === 'support') renderIncoming(entry?.data);
    else renderFinance(entry?.data);
  }

  async function load(force = false) {
    const key = selectedKey();
    const previous = entries.get(key);
    if (!canLoad() || previous?.controller || previous && !force) {
      render();
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    entries.set(key, { data: previous?.data, controller });
    render();
    try {
      const data = key === 'incoming' ? await loadDashboardIncoming(readIncoming, signal) :
        await loadDashboardStatement(request, account, key, signal);
      if (!signal.aborted) entries.set(key, { data });
    } catch (error) {
      if (signal.aborted) return;
      const message = error.status === 403 ? (key === 'incoming' ? 'Проверьте право на просмотр пополнений.' : 'Проверьте право на получение выписки.') :
        error.name === 'TimeoutError' ? 'Время ожидания ответа истекло.' : error.message;
      entries.set(key, { data: previous?.data, error: message });
    }
    if (!signal.aborted && key === selectedKey()) render();
  }

  function select(tab) {
    if (view === tab.dataset.view) return;
    view = tab.dataset.view;
    updateTabs();
    load();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const keys = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 };
      if (!Object.hasOwn(keys, event.key)) return;
      event.preventDefault();
      const next = tabs[(keys[event.key] + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
  periods.forEach(item => item.addEventListener('click', () => {
    const period = Number(item.dataset.period);
    if (days === period) return;
    days = period;
    updateTabs();
    load();
  }));
  refresh.addEventListener('click', () => load(true));
  incomingLink.addEventListener('click', () => {
    const entry = entries.get('incoming');
    navigate('incoming-transactions', entry?.error ? undefined : entry?.data?.page);
  });

  return {
    reset() {
      for (const entry of entries.values()) entry.controller?.abort();
      entries.clear();
      enabled = false;
      account = undefined;
      view = 'support';
      days = 7;
      part('support-content').replaceChildren();
      part('finance-content').replaceChildren();
      updateTabs();
      render();
    },
    open(number, signedIn) {
      account = number;
      enabled = signedIn;
      load();
    },
    invalidateIncoming() {
      entries.get('incoming')?.controller?.abort();
      entries.delete('incoming');
    },
  };
}
