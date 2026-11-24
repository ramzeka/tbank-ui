import { dashboardMoney, loadDashboardDeals, loadDashboardFinance, loadDashboardIncoming, loadDashboardPayments } from './dashboard-data.js';
import { tableCell, tableHeaders } from './record-details.js';
import { paymentFailureReason } from './billing.js';

const count = new Intl.NumberFormat('ru-RU');
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const exactAxis = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = new Intl.PluralRules('ru-RU');
const svg = 'http://www.w3.org/2000/svg';

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

function statusText(entry) {
  if (!entry) return 'Загружаем данные…';
  return entry.error;
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

function ageLabel(age) {
  if (age === undefined) return '—';
  const unit = { one: 'день', few: 'дня', many: 'дней' }[plural.select(age)];
  return `${count.format(age)} ${unit}`;
}

function amountSummary(entry) {
  if (!entry?.data) return statusText(entry);
  if (entry.data.totals === null) return 'Сумма недоступна';
  const values = Array.from(entry.data.totals, ([currency, amount]) => dashboardMoney(amount, currency));
  return values.length ? values.join(' · ') : dashboardMoney(0n, 'RUB');
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

function balanceChart({ timeline, currency, opening, closing }) {
  const points = timeline.filter(day => day.balance !== null);
  if (!points.length) return notice('В выписке нет данных об остатках.');
  const offsets = points.map(day => day.balance - points[0].balance);
  const low = offsets.reduce((a, b) => a < b ? a : b);
  const high = offsets.reduce((a, b) => a > b ? a : b);
  const padding = high - low < 100n ? 15n : (high - low) / 10n;
  const ymin = low - padding;
  const ymax = high + padding;
  const y = balance => 150 - 150 * Number(balance - points[0].balance - ymin) / Number(ymax - ymin);
  const x = index => 6 + 588 * index / (timeline.length - 1);
  const chart = document.createElementNS(svg, 'svg');
  chart.setAttribute('viewBox', '0 0 600 150');
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('role', 'img');
  const description = points.map(day => `${dateLabel(day.day)}: ${dashboardMoney(day.balance, currency)}`).join('; ');
  chart.setAttribute('aria-label', 'Остаток по дням. ' + description);
  const path = document.createElementNS(svg, 'path');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  let connected = false;
  const coordinates = [];
  timeline.forEach((day, index) => {
    if (day.balance === null) { connected = false; return; }
    const cx = x(index);
    const cy = y(day.balance);
    coordinates.push(`${connected ? 'L' : 'M'} ${cx} ${cy}`);
    connected = true;
    const dot = document.createElementNS(svg, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', index === timeline.length - 1 ? 5 : 3);
    const title = document.createElementNS(svg, 'title');
    title.textContent = `${dateLabel(day.day)} · ${dashboardMoney(day.balance, currency)}`;
    dot.append(title);
    chart.append(dot);
  });
  path.setAttribute('d', coordinates.join(' '));
  chart.prepend(path);
  const plot = element('div', 'dashboard-plot dashboard-line');
  plot.append(chart);
  const host = element('div', 'dashboard-balance');
  host.append(notice('На конец дня · ' + (currency === 'RUB' ? '₽' : currency)));
  const axis = [3n, 2n, 1n, 0n].map(step => Number(points[0].balance + ymin + (ymax - ymin) * step / 3n) / 100);
  const labels = axis.map(value => compact.format(value));
  host.append(graphFrame(new Set(labels).size === labels.length ? labels : axis.map(value => exactAxis.format(value)), plot,
    [dateLabel(timeline[0].day), dateLabel(timeline.at(-1).day)]));
  const detail = opening !== null ? 'Входящий остаток ' + dashboardMoney(opening, currency) :
    closing !== null ? 'Остаток на конец периода ' + dashboardMoney(closing, currency) : '';
  host.append(notice(detail));
  return host;
}

function distribution(entries) {
  const max = Math.max(1, ...entries.map(([, value]) => value));
  const host = element('ul', 'dashboard-distribution');
  for (const [label, value] of entries) {
    const row = element('li');
    const rail = element('span', 'dashboard-rail');
    rail.setAttribute('aria-hidden', 'true');
    const bar = element('span');
    bar.style.width = `${100 * value / max}%`;
    rail.append(bar);
    row.append(element('span', '', label), rail, element('strong', '', count.format(value)));
    host.append(row);
  }
  return host;
}

export function initDashboard(root, { request, read, navigate, openIncoming, openPayment }) {
  const part = name => root.querySelector(`[data-dashboard="${name}"]`);
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const periods = [...root.querySelectorAll('[data-period]')];
  const queues = [...root.querySelectorAll('[data-queue]')];
  const refresh = part('refresh');
  const accountLabel = part('account');
  const finance = part('finance');
  const operations = part('operations');
  const entries = new Map();
  let view = 'finance';
  let days = 30;
  let queue = 'incoming';
  let account;
  let enabled = false;
  let active;

  function setPressed(buttons, selected) {
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === selected)));
  }

  function renderFinance(entry) {
    const host = part('finance-content');
    const data = entry?.data;
    if (!data) {
      host.replaceChildren(notice(statusText(entry), entry?.error ? 'error' : 'loading'));
      return;
    }
    const { timeline, opening, closing, credit, debit, currency, recent } = data;
    const period = `${dateLabel(timeline[0].day)} — ${dateLabel(timeline.at(-1).day)}`;
    const net = opening !== null && closing !== null ? closing - opening : null;
    const stats = element('div', 'dashboard-stats');
    stats.append(
      stat('Остаток на конец периода', dashboardMoney(closing, currency), net === null ? period : `${net > 0n ? '+' : ''}${dashboardMoney(net, currency)} за период`, net > 0n ? 'success' : undefined),
      stat('Поступления', dashboardMoney(credit, currency), period),
      stat('Списания', dashboardMoney(debit, currency), period),
    );
    const plots = element('div', 'dashboard-figures');
    plots.append(panel('Движение денег', flowChart(data), null, true), panel('Остаток по дням', balanceChart(data), null, true));
    const rows = recent.map(row => {
      const value = dashboardMoney(row.units, currency);
      const sum = row.units === null || !['credit', 'debit'].includes(row.kind) ? value : (row.kind === 'credit' ? '+' : '−') + value;
      const amount = element('span', 'dashboard-amount', sum);
      if (row.kind === 'credit') amount.dataset.state = 'success';
      return [operationDate(row.date), row.party, row.purpose, amount];
    });
    const recentTable = rows.length ? table(['Дата (МСК)', 'Контрагент', 'Назначение', 'Сумма'], rows, 'Последние проведённые операции') :
      notice('За выбранный период проведённых операций нет.');
    host.replaceChildren(stats, plots, panel('Последние операции', recentTable, button('К выписке', () => navigate('statement'))));
  }

  function renderQueue() {
    const entry = entries.get(queue);
    const host = part('queue-content');
    const focused = host.contains(document.activeElement) ? document.activeElement.dataset.operationId : undefined;
    const isIncoming = queue === 'incoming';
    const label = isIncoming ? 'Пополнения' : 'Платежи';
    const link = part('queue-link');
    const records = entry?.data?.rows ?? entry?.preview;
    link.textContent = isIncoming ? 'К пополнениям' : 'К платежам';
    link.hidden = !records;
    if (!records) {
      host.replaceChildren(notice(statusText(entry), entry?.error ? 'error' : 'loading'));
      if (focused) queues.find(button => button.dataset.queue === queue)?.focus({ preventScroll: true });
      return;
    }
    if (!records.length) {
      host.replaceChildren(notice(isIncoming ? 'Все пополнения идентифицированы.' : 'Неуспешных попыток выплат нет.'));
      if (focused) link.focus({ preventScroll: true });
      return;
    }
    let nextFocus;
    const rows = records.map(({ item, date, age, amount, currency }) => {
      const value = element('span', 'dashboard-amount', dashboardMoney(amount, currency));
      const id = isIncoming ? item.operationId : item.paymentId;
      const control = isIncoming ? button(item.payerName || id, () => openIncoming(item)) :
        button(item.bankDetails?.name || id, () => openPayment(id));
      control.dataset.operationId = id;
      if (id === focused) nextFocus = control;
      return isIncoming ? [operationDate(date), control, ageLabel(age), value] : [control, paymentFailureReason(item), value];
    });
    const headers = isIncoming ? ['Дата (МСК)', 'Плательщик', 'Без идентификации', 'Сумма'] : ['Получатель', 'Причина ошибки', 'Сумма'];
    host.replaceChildren(table(headers, rows, label));
    if (focused) (nextFocus ?? link).focus({ preventScroll: true });
    if (!entry.data) {
      host.append(notice('Предварительные данные. Загружаем полный список…', 'loading'));
    } else if (entry.data.count > rows.length) {
      const start = isIncoming ? 'Старейшие по дате · ' : '';
      host.append(notice(`${start}Показано ${count.format(rows.length)} из ${count.format(entry.data.count)}`));
    }
  }

  function renderOperations() {
    const incoming = entries.get('incoming');
    const payments = entries.get('payments');
    const deals = entries.get('deals');
    function metric(entry, label, detail) {
      return stat(label, entry?.data ? count.format(entry.data.count) : '—', detail, entry?.error ? 'error' : undefined);
    }
    part('operations-stats').replaceChildren(
      metric(incoming, 'Пополнения без идентификации', amountSummary(incoming)),
      metric(payments, 'Неуспешные попытки выплат', amountSummary(payments)),
      metric(deals, 'Сделки в работе', deals?.data ? 'Подтверждены или в процессе' : statusText(deals)),
    );
    const charts = [['age', incoming, 'ages'], ['deals', deals, 'status']];
    for (const [partName, entry, key] of charts) {
      part(partName).replaceChildren(entry?.data ? distribution(entry.data[key]) : notice(statusText(entry), entry?.error ? 'error' : 'loading'));
    }
  }

  function render(key) {
    if (key === 'finance') renderFinance(entries.get(days));
    else {
      renderOperations();
      if (key === queue || key === 'operations') renderQueue();
    }
  }

  function load(force = false) {
    active?.abort();
    active = undefined;
    const canLoad = enabled && account && (view !== 'finance' || account.length === 20);
    const status = part('status');
    refresh.disabled = !canLoad;
    status.hidden = Boolean(canLoad);
    status.textContent = !enabled ? 'Войдите в настройках подключения, чтобы загрузить обзор.' :
      !account ? 'Укажите номер номинального счёта в настройках подключения.' :
      'Для выписки нужен 20-значный номер счёта. Данные номинального счёта доступны во вкладке «Операционный контроль».';
    accountLabel.hidden = !enabled || !account;
    accountLabel.textContent = enabled && account ? 'Счёт •• ' + account.slice(-4) : '';
    finance.hidden = view !== 'finance';
    operations.hidden = view !== 'operations';
    part('periods').hidden = !canLoad || view !== 'finance';
    part('finance-content').hidden = !canLoad;
    part('operations-content').hidden = !canLoad;
    if (!canLoad) return;

    const controller = new AbortController();
    const { signal } = controller;
    const now = new Date();
    const period = days;
    const jobs = view === 'finance' ? [[period, () => loadDashboardFinance(request, account, period, signal, now)]] : [
      ['incoming', preview => loadDashboardIncoming(read, signal, now, preview)],
      ['payments', preview => loadDashboardPayments(read, signal, preview)],
      ['deals', () => loadDashboardDeals(read, account, signal)],
    ];
    const pending = jobs.filter(([key]) => force || (!entries.get(key)?.data && !entries.get(key)?.error));
    for (const [key] of pending) entries.delete(key);
    render(view);
    if (!pending.length) return;

    active = controller;
    refresh.disabled = true;
    Promise.all(pending.map(async ([key, fetch]) => {
      try {
        const data = await fetch(preview => {
          if (signal.aborted) return;
          entries.set(key, { preview });
          if (key === queue) renderQueue();
        });
        if (!signal.aborted) entries.set(key, { data });
      } catch (error) {
        if (signal.aborted) return;
        const detail = key === period && error.status === 403 ? 'Проверьте право на получение выписки.' : error.message;
        entries.set(key, { error: detail });
      }
      if (!signal.aborted) render(key === period ? 'finance' : key);
    })).finally(() => {
      if (active !== controller) return;
      active = undefined;
      refresh.disabled = false;
    });
  }

  function select(tab) {
    if (view === tab.dataset.view) return;
    view = tab.dataset.view;
    tabs.forEach(item => {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
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
    setPressed(periods, item);
    load();
  }));
  queues.forEach(item => item.addEventListener('click', () => {
    queue = item.dataset.queue;
    setPressed(queues, item);
    renderQueue();
  }));
  part('queue-link').addEventListener('click', () => navigate(queue === 'incoming' ? 'incoming-transactions' : 'payments'));
  refresh.addEventListener('click', () => load(true));

  function reset() {
    active?.abort();
    active = undefined;
    entries.clear();
    enabled = false;
    account = undefined;
    for (const name of ['finance-content', 'operations-stats', 'queue-content', 'age', 'deals']) part(name).replaceChildren();
    load();
  }

  return { reset, open(number, signedIn) {
    account = number;
    enabled = signedIn;
    load();
  } };
}
