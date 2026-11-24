import { randomUUID } from 'node:crypto';
import { mockStageParties } from './mock-stage-parties.mjs';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function mockDeals(uuid, accountNumber, bankingFixtures) {
  const parties = mockStageParties(uuid, accountNumber, bankingFixtures);
  const deals = new Map();
  const idempotency = new Map();
  const fixtures = [
    ['DRAFT', [['Подготовка комплекта образцов', 'NEW'], ['Передача итоговых материалов', 'NEW']]],
    ['ACCEPTED', [['Аванс по договору', 'NEW'], ['Финальный расчёт', 'NEW']]],
    ['IN_PROGRESS', [['Первая выплата', 'COMPLETED'], ['Вторая выплата', 'NEW']]],
    ['COMPLETED', [['Расчёт за завершённые работы', 'COMPLETED']]],
    ['CANCELLED', [['Отменённый этап', 'CANCELLED']]],
    ['IN_PROGRESS', [['Выплата требует внимания', 'PAYMENT_FAILED']]],
    ['DRAFT', Array.from({ length: 53 }, (_, index) => ['Этап проектирования ' + (index + 1), 'NEW'])],
  ];
  for (let index = 0; index < 58; index++) {
    const dealId = uuid(200001 + index);
    const lateSteps = index === 57 ? [['Контрольная сверка', 'NEW']] : [];
    const [status, sampleSteps] = fixtures[index] ?? ['DRAFT', lateSteps];
    const steps = new Map();
    let nextStep = 1;
    for (const [description, state] of sampleSteps) {
      const stepId = uuid(300000 + index * 100 + nextStep);
      const step = { dealId, stepId, stepNumber: nextStep++, description, status: state };
      steps.set(stepId, step);
      if (index < 6 || index === 57 || (index === 6 && step.stepNumber > 1)) parties.seed(step, index);
      if (index === 6 && step.stepNumber === 1) parties.seedMany(step);
    }
    deals.set(dealId, { dealId, accountNumber, status, steps, nextStep });
  }

  const view = ({ steps, nextStep, ...deal }) => deal;

  return function handle(req, { id, sub, bid, action, rest, reply, error, list }) {
    const method = req.method;
    if (sub === 'steps' && bid && ['deponents', 'recipients'].includes(action)) {
      const deal = deals.get(id);
      const step = deal?.steps.get(bid);
      if (!step) return error(404, 'У сделки нет этапа с таким ID.');
      return parties.handle(req, deal, step, action, rest, { reply, error, list });
    }
    if (rest.length) return error(404, 'Маршрут не найден.');

    function save(path, field, valid, create) {
      const raw = req.mockBody;
      const body = JSON.parse(raw);
      if (!valid(body?.[field])) return error(400, 'Проверьте поле ' + field + '.');
      const key = req.headers['idempotency-key'];
      if (!uuidPattern.test(key)) return error(400, 'Требуется Idempotency-Key.');
      const cacheKey = path + '/' + key;
      const previous = idempotency.get(cacheKey);
      if (previous) return previous.raw === raw ? reply(201, previous.result) : error(409, 'Ключ уже использован.');
      const result = create(body[field]);
      if (!result) return error(422, 'Добавлять этапы можно только в черновике.');
      idempotency.set(cacheKey, { raw, result: { ...result } });
      return reply(201, result);
    }

    if (!id) {
      if (method === 'GET') return list([...deals.values()].map(view), 50);
      if (method === 'POST') return save('/deals', 'accountNumber', value => typeof value === 'string' && /^(?:\d{20}|\d{22})$/.test(value), value => {
        const deal = { dealId: randomUUID(), accountNumber: value, status: 'DRAFT', steps: new Map(), nextStep: 1 };
        deals.set(deal.dealId, deal);
        return view(deal);
      });
      return error(405, 'Метод недоступен для списка сделок.');
    }

    const deal = deals.get(id);
    if (!deal) return error(404, 'Сделка не найдена.');
    const isDraft = deal.status === 'DRAFT';
    const accepted = deal.status === 'ACCEPTED';

    if (!sub && method === 'GET') return reply(200, view(deal));
    if (!sub && method === 'DELETE') {
      if (!isDraft) return error(422, 'Удалить можно только черновик.');
      for (const step of deal.steps.values()) parties.remove(step);
      deals.delete(deal.dealId);
      return reply(200);
    }
    if (sub === 'is-valid' && !bid && method === 'GET') {
      const reasons = [];
      if (!deal.steps.size) reasons.push({ code: 'NO_STEPS_IN_DEAL', description: 'В сделке нет этапов.' });
      if (deal.status === 'CANCELLED') reasons.push({ code: 'DEMO_DEAL_CANCELLED', description: 'Сделка отменена.' });
      if (deal.steps.size && deal.status !== 'CANCELLED') reasons.push(...parties.check(deal, [...deal.steps.values()], true));
      return reply(200, { isValid: !reasons.length, reasons });
    }
    if (!bid && method === 'POST') {
      if (sub === 'accept') {
        if (!isDraft || !deal.steps.size) return error(422, 'Подтвердить можно черновик с этапами.');
        const issues = parties.check(deal, [...deal.steps.values()], false);
        if (issues.length) return error(422, 'Проверьте участников этапов.', issues);
        deal.status = 'ACCEPTED';
        return reply(200);
      }
      if (sub === 'draft') {
        if (!accepted) return error(422, 'Вернуть в черновик можно подтверждённую сделку.');
        deal.status = 'DRAFT';
        return reply(200);
      }
      if (sub === 'cancel') {
        if (![...deal.steps.values()].every(step => step.status === 'NEW') ||
            !['DRAFT', 'ACCEPTED', 'IN_PROGRESS'].includes(deal.status)) {
          return error(422, 'Сделку с выполненными или начатыми выплатами нельзя отменить.');
        }
        deal.status = 'CANCELLED';
        for (const step of deal.steps.values()) step.status = 'CANCELLED';
        return reply(200);
      }
    }

    if (sub !== 'steps') return error(404, 'Маршрут сделки не найден.');
    const validDescription = value => typeof value === 'string' && value.trim().length >= 3 && value.length <= 4096;
    if (!bid) {
      if (method === 'GET') return list([...deal.steps.values()], 50);
      if (method === 'POST') return save('/deals/' + id + '/steps', 'description', validDescription, description => {
        if (deal.status !== 'DRAFT') return undefined;
        const step = { dealId: id, stepId: randomUUID(), stepNumber: deal.nextStep++, description, status: 'NEW' };
        deal.steps.set(step.stepId, step);
        return step;
      });
      return error(405, 'Метод недоступен для списка этапов.');
    }
    const step = deal.steps.get(bid);
    if (!step) return error(404, 'У сделки нет этапа с таким ID.');
    if (!action && method === 'GET') return reply(200, step);
    if (!action && method === 'DELETE') {
      if (!isDraft) return error(422, 'Удалить этап можно только в черновике.');
      parties.remove(step);
      deal.steps.delete(step.stepId);
      return reply(200);
    }
    if (!action && method === 'PUT') {
      const body = JSON.parse(req.mockBody);
      if (deal.status !== 'DRAFT') return error(422, 'Изменить этап можно только в черновике.');
      if (!validDescription(body?.description)) return error(400, 'Проверьте описание этапа.');
      step.description = body.description;
      return reply(200, step);
    }
    if (action === 'complete' && method === 'POST') {
      if (!['ACCEPTED', 'IN_PROGRESS'].includes(deal.status) || !['NEW', 'PAYMENT_FAILED'].includes(step.status)) {
        return error(422, 'Этап нельзя завершить в текущем статусе.');
      }
      const issues = parties.check(deal, [step], true);
      if (issues.length) return error(422, 'Этап пока нельзя завершить.', issues);
      parties.settle(step);
      step.status = 'COMPLETED';
      deal.status = [...deal.steps.values()].every(item => item.status === 'COMPLETED') ? 'COMPLETED' : 'IN_PROGRESS';
      return reply(200);
    }
    return error(405, 'Метод недоступен для этапа.');
  };
}
