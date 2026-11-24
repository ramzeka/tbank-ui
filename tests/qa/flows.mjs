
import { assert, until, testToken, demoAccount, uuid, path } from './harness.mjs';

export const u1 = uuid(1), u2 = uuid(2), u3 = uuid(3), u4 = uuid(4);
export const bankPath = id => path.beneficiaries + '/' + id + '/bank-details';
export const stepsPath = id => path.deals + '/' + id + '/steps';
export const stepPath = (deal, step) => stepsPath(deal) + '/' + step;
export const row = (index, field) => '#distribution-rows .distribution-row:nth-child(' + index + ') [name=' + field + ']';
const panels = {
  beneficiaries: ['#beneficiary-view', '#beneficiary-close', '#detail-form', '#item-id'],
  deals: ['#deal-panel', '#deal-back', '#deal-search', '#deal-search-id'],
  payments: ['#payment-panel', '#payment-back', '#payment-search', '#payment-search-id'],
  transfers: ['#transfer-panel', '#transfer-back', '#transfer-search', '#transfer-search-id'],
  'incoming-transactions': ['#transaction-panel', '#transaction-back', '#transaction-search', '#transaction-search-id'],
};

export async function settings(t, { account = demoAccount, accountId = uuid(990) } = {}) {
  if (!await t.visible('#proxy')) await t.click('#settings-link');
  await t.fill('#account-number', account);
  await t.fill('#bank-account-id', accountId);
  await t.click('#settings-form button[type=submit]');
}

export async function sign(t, value = testToken) {
  if (!await t.visible('#access-token')) await t.click('#settings-link');
  await t.fill('#access-token', value);
  await t.click('#token-login');
}

export async function reload(t) {
  await t.send('Page.navigate', { url: t.origin + '/' });
  await t.wait('#settings-link');
  await sign(t);
  await t.has('#session-status', 'Токен подключён');
}

export async function list(t, section) {
  const [panel, back] = panels[section] ?? [];
  if (panel && await t.visible(panel)) await t.click(back);
  await t.navigate(section);
}

export async function open(t, section, id) {
  const [panel, , form, field] = panels[section];
  await t.fill(field, id);
  await t.click(form + ' button[type=submit]');
  await t.wait(panel);
}

export async function fields(t, scope, values) {
  for (const [name, value] of Object.entries(values)) await t.fill(scope + ' [name="' + name + '"]', value);
}

export const entity = (t, values) => fields(t, '#entity-fields', values);

export async function org(t, name, inn = '0000000625', email = 'qa@example.org') {
  await t.click('#beneficiary-create');
  await entity(t, { type: 'UL_RESIDENT', inn, name, ...(email && { email }) });
}

export function sameKey(first, retry) {
  assert.match(first.key, /^[0-9a-f-]{36}$/i);
  assert.equal(first.key, retry.key);
  assert.deepEqual(first.body, retry.body);
}

export const last = (t, method, route) => t.calls(method, route).at(-1);
export const count = (t, selector = '#result tbody tr') => t.evaluate(selector => document.querySelectorAll(selector).length, selector);
export const focus = t => t.evaluate(() => document.activeElement?.id);
export const ready = (t, selector) => until(() => t.evaluate(selector => {
  const control = document.querySelector(selector);
  return Boolean(control?.getClientRects().length && !control.matches(':disabled'));
}, selector), selector + ' готов');

export async function confirmAction(t, control, status, expected) {
  await t.click(control);
  await t.has(status, expected);
}

export async function payment(t, amount = '17,05', purpose = 'QA платёж') {
  await t.click('#billing-create');
  await t.fill('#billing-from', u1);
  await t.fill('#billing-amount', amount);
  await t.fill('#billing-purpose', purpose);
  await t.click('#billing-bank-load');
  await t.has('#billing-bank-status', 'Атлас');
}

export async function transfer(t, { sender = u1, recipient = u3, amount = '5,19', purpose = 'QA перевод' } = {}) {
  await t.click('#billing-create');
  await t.fill('#billing-from', sender);
  await t.fill('#billing-to', recipient);
  await t.fill('#billing-amount', amount);
  await t.fill('#billing-purpose', purpose);
}

export async function identify(t, id, recipient) {
  await list(t, 'incoming-transactions');
  await open(t, 'incoming-transactions', id);
  await t.clickText('#transaction-actions', 'Идентифицировать');
  await t.fill(row(1, 'beneficiaryId'), recipient);
}

export async function deal(t) {
  await list(t, 'deals');
  await confirmAction(t, '#deal-create', '#deal-editor-title', 'Создать сделку');
  await confirmAction(t, '#deal-save', '#deal-status', 'Сделка создана');
  return last(t, 'POST', path.deals).response.dealId;
}

export async function step(t, dealId, description) {
  await t.click('#step-create');
  await t.fill('#step-description', description);
  await confirmAction(t, '#deal-save', '#step-status', 'Этап добавлен');
  return last(t, 'POST', stepsPath(dealId)).response.stepId;
}

export async function openStep(t, id) {
  await t.click('[data-step-id="' + id + '"]');
  await t.wait('#step-panel');
}

export const partyGroup = kind => '#step-parties .step-party-group:nth-child(' + (kind === 'deponents' ? 1 : 2) + ')';

export async function party(t, kind, id, amount) {
  await t.click(partyGroup(kind) + ' [data-action=add]');
  await t.fill('#party-beneficiary', id);
  await t.fill('#party-amount', amount);
}
