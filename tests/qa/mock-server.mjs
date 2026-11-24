import { startMock, testToken, demoAccount, uuid } from './mocks/mock.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--scale')) {
  throw new Error('Использование: node tests/qa/mock-server.mjs [--scale]');
}
const mock = await startMock({ large: args.includes('--scale') });
console.log('Базовый URL прокси:', mock.origin);
console.log('bankAccountId:', uuid(990));
console.log('accountNumber:', demoAccount);
console.log('Демонстрационный токен:', testToken);
