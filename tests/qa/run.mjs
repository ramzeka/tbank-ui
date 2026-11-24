import { coverage, run, test } from './harness.mjs';
import { login, security } from './security.test.mjs';
import { participants } from './participants.test.mjs';
import { billing, scaleBilling } from './billing.test.mjs';
import { deals } from './deals.test.mjs';
import { dashboard, interfaces } from './interface.test.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node tests/qa/run.mjs [--scale | --filter REGEXP]');
} else {
  const large = args.length === 1 && args[0] === '--scale';
  const filter = args.length === 2 && args[0] === '--filter' ? new RegExp(args[1]) : undefined;
  if (args.length && !large && !filter) throw new Error('Используйте --help для списка режимов.');
  const matrix = test('COVERAGE-01', 'Сверка успешных HTTP-операций с README', t => coverage(t.trace));
  const checks = large ? [...scaleBilling, dashboard] : [
    ...participants, ...billing, ...deals, dashboard, ...interfaces, ...security, ...(!filter ? [matrix] : []),
  ];
  const suite = [login, ...checks];
  if (filter && !suite.some(item => filter.test(item.id))) throw new Error('Фильтр не выбрал ни одной проверки.');
  await run(suite, { large, filter });
}
