const $ = id => document.getElementById(id);
const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeZone: 'UTC' });

export function moscowClock(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

export function dateTimeValue(date) {
  return date.toISOString().slice(0, 16);
}

export function initStatementCalendar() {
  const dialog = $('statement-calendar');
  const days = $('calendar-days');
  const time = $('calendar-time');
  let field;
  let selected;
  let month;

  function showMonth() {
    $('calendar-month').textContent = monthFormat.format(month);
    days.replaceChildren();
    const start = (month.getUTCDay() + 6) % 7;
    for (let cell = 0; cell < start; cell++) days.append(document.createElement('span'));
    const date = new Date(month);
    while (date.getUTCMonth() === month.getUTCMonth()) {
      const day = dateTimeValue(date).slice(0, 10);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = date.getUTCDate();
      button.setAttribute('aria-label', dayFormat.format(date));
      button.setAttribute('aria-pressed', String(day === selected));
      button.addEventListener('click', () => {
        days.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
        selected = day;
        button.setAttribute('aria-pressed', 'true');
      });
      days.append(button);
      date.setUTCDate(date.getUTCDate() + 1);
    }
  }

  function moveMonth(offset) {
    month.setUTCMonth(month.getUTCMonth() + offset, 1);
    showMonth();
  }

  for (const button of document.querySelectorAll('[data-date-for]')) button.addEventListener('click', () => {
    field = $(button.dataset.dateFor);
    const [day, clock] = (field.value || dateTimeValue(moscowClock())).split('T');
    selected = day;
    time.value = clock;
    month = new Date(day + 'T00:00:00Z');
    month.setUTCDate(1);
    showMonth();
    dialog.showModal();
    days.querySelector('[aria-pressed="true"]').focus();
  });
  $('calendar-prev').addEventListener('click', () => moveMonth(-1));
  $('calendar-next').addEventListener('click', () => moveMonth(1));
  $('calendar-cancel').addEventListener('click', () => dialog.close());
  $('calendar-form').addEventListener('submit', () => {
    field.value = selected + 'T' + time.value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return () => dialog.close();
}
