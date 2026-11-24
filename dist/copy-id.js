export function appendCopyId(container, id, label) {
  if (typeof id !== 'string' && !Number.isSafeInteger(id)) return;
  const value = String(id);
  if (!value.trim() || value === '—') return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-id';
  button.title = 'Скопировать ' + label;
  button.setAttribute('aria-label', button.title + ' ' + value);
  let reset;
  button.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(value);
      button.classList.remove('copy-error');
      button.classList.add('copied');
      button.title = 'Скопировано';
      status.textContent = label + ' скопирован';
    } catch {
      button.classList.remove('copied');
      button.classList.add('copy-error');
      button.title = 'Не удалось скопировать ID';
      status.textContent = button.title;
    }
    clearTimeout(reset);
    reset = setTimeout(() => {
      button.classList.remove('copied', 'copy-error');
      button.title = 'Скопировать ' + label;
    }, 1600);
  });
  container.append(button);
}
