// Work in minor units so decimal amounts compare exactly.
export function minorUnits(value) {
  const text = String(value ?? '').trim();
  const parts = /^(\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!parts) return null;
  const whole = parts[1].replace(/[ \u00a0\u202f]/g, '');
  if (whole.length > 16) return null;
  return BigInt(whole) * 100n + BigInt((parts[2] ?? '').padEnd(2, '0'));
}

export function decimal(units) {
  const n = units < 0n ? -units : units;
  return (units < 0n ? '-' : '') + String(n / 100n) + '.' + String(n % 100n).padStart(2, '0');
}

const amountFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatAmount(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? amountFormat.format(number) : value;
}
