export const maxOffset = 2147483647;

const countFormat = new Intl.NumberFormat('ru-RU');

export function pageFor({ rows, total }, offset, limit) {
  const count = rows.length;
  if (count && total < offset + count) total = undefined;
  const last = total === undefined ? undefined : Math.min(Math.ceil(total / limit), Math.floor(maxOffset / limit) + 1);
  const hasNext = total === undefined ? count === limit : offset + limit < total;
  return { offset, limit, rows, count, total, last, hasNext: hasNext && offset + limit <= maxOffset };
}

export async function readPage(read, offset, limit, previous, signal) {
  let result = await read(offset);
  signal.throwIfAborted();
  if (!result.rows.length && result.total !== undefined && offset && offset >= result.total) {
    offset = Math.max(0, Math.ceil(result.total / limit) - 1) * limit;
    result = await read(offset);
    signal.throwIfAborted();
  } else if (!result.rows.length && result.total === undefined && previous?.limit === limit &&
    previous.hasNext && offset === previous.offset + limit) {
    return { ...previous, hasNext: false };
  }
  return pageFor(result, offset, limit);
}

function visiblePages(current, last, hasNext) {
  if (last !== undefined && last <= 7) return Array.from({ length: last }, (_, index) => index + 1);
  const numbers = [1, current - 1, current, current + 1];
  if (last !== undefined) {
    numbers.push(last);
    if (current <= 3 || current >= last - 2) numbers.push(2, 3, last - 2, last - 1);
  }
  const end = last ?? (hasNext ? current + 1 : current);
  return [...new Set(numbers)].filter(number => number >= 1 && number <= end).sort((a, b) => a - b);
}

export function initPagination(root, onPage, defaultLimit = 50) {
  root.append(document.getElementById('pagination-template').content.cloneNode(true));
  const part = name => root.querySelector('[data-page="' + name + '"]');
  const limit = part('limit');
  const numbers = part('numbers');
  const jump = part('jump');
  const number = part('number');
  const first = part('first');
  const previous = part('previous');
  const next = part('next');
  const last = part('last');
  let page;
  let busy = false;

  const current = () => page ? page.offset / page.limit + 1 : 1;

  function updateControls(value) {
    busy = value;
    limit.disabled = busy;
    first.disabled = previous.disabled = busy || !page?.offset;
    next.disabled = busy || !page?.hasNext;
    last.disabled = next.disabled || !page?.last;
    for (const button of numbers.querySelectorAll('button')) button.disabled = busy;
    number.disabled = jump.querySelector('button').disabled = busy;
  }

  async function goToPage(target) {
    if (!page || busy || !Number.isSafeInteger(target) || target < 1 || target > (page.last ?? Infinity)) return;
    const offset = (target - 1) * page.limit;
    if (offset === page.offset || offset > maxOffset) return;
    const source = document.activeElement;
    const restoreFocus = root.contains(source);
    await onPage(offset, page.limit);
    if (restoreFocus && document.activeElement === document.body && root.getClientRects().length) {
      const control = source.isConnected && !source.disabled ? source : numbers.querySelector('[aria-current="page"]');
      control?.focus({ preventScroll: true });
    }
  }

  function render(value) {
    page = value;
    numbers.replaceChildren();
    jump.hidden = (page?.last ?? 0) <= 7;
    part('summary').textContent = '';
    if (page) {
      const { offset, count, total, last, hasNext } = page;
      const format = value => countFormat.format(value);
      part('summary').textContent = count ? (total === undefined ? 'Записей на странице — ' + format(count)
        : 'Записи ' + format(offset + 1) + '–' + format(offset + count) + ' из ' + format(total))
        : offset ? 'На странице нет записей.' : 'Нет записей.';
      if (last !== undefined) {
        number.max = last;
        number.value = current();
      }
      const addPage = value => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = value;
        button.setAttribute('aria-label', 'Страница ' + value);
        if (value === current()) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => goToPage(value));
        numbers.append(button);
      };
      let prior = 0;
      for (const value of count || offset ? visiblePages(current(), last, hasNext) : []) {
        if (value - prior === 2) addPage(prior + 1);
        else if (value - prior > 2) {
          const gap = document.createElement('span');
          gap.className = 'page-gap';
          gap.textContent = '…';
          gap.setAttribute('aria-hidden', 'true');
          numbers.append(gap);
        }
        addPage(value);
        prior = value;
      }
    }
    updateControls(busy);
  }

  limit.addEventListener('change', () => onPage(0, Number(limit.value)));
  first.addEventListener('click', () => goToPage(1));
  previous.addEventListener('click', () => goToPage(current() - 1));
  next.addEventListener('click', () => goToPage(current() + 1));
  last.addEventListener('click', () => goToPage(page?.last));
  jump.addEventListener('submit', event => {
    event.preventDefault();
    goToPage(number.valueAsNumber);
  });

  return { limit, render, updateControls, setSizes(sizes) {
    limit.replaceChildren(...sizes.map(size => new Option(size, size, false, size === defaultLimit)));
  } };
}
