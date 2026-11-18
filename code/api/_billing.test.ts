import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import billingModule from './_billing.js';
import entitlementModule from './_examEntitlement.js';
import webhookModule from './billing/webhook.js';
import checkoutModule from './billing/checkout.js';
import interviewModule from './exam/interview.js';
import accessModule from './exam/access.js';
import securityModule from './_security.js';

type Handler = (req: unknown, res: unknown, deps?: Record<string, unknown>) => Promise<void>;
type Scopes = { exam?: number; constitution?: number };
const billing = billingModule as unknown as {
  addMonthsUTC: (ms: number, months: number) => number;
  endOfDayVilnius: (year: number, month: number, day: number) => number;
  vilniusDate: (ms: number) => { year: number; month: number; day: number };
  paidUntilFromGrants: (grants: unknown, scope?: 'exam' | 'constitution') => number;
  untilsFromGrants: (grants: unknown) => { exam: number; constitution: number };
  previewUntil: (grants: unknown, scope: 'exam' | 'constitution', months: number, now: number) => number;
  grantScopes: (grant: unknown) => Scopes;
  scopesForProduct: (id: string, env: Record<string, string>) => Scopes;
  resolvePlan: (plan: unknown) => string;
  productIdForPlan: (plan: unknown, env: Record<string, string>) => string;
  productKeyForId: (productId: string, env?: Record<string, string>) => string;
  scopeStringForPlan: (plan: string) => string;
  scopeStringForProduct: (productId: string, env?: Record<string, string>) => string;
  extractPolarStatus: (error: unknown) => number | undefined;
  extractRequestId: (req: unknown) => string | undefined;
  isFullRefund: (order: unknown) => boolean;
  isPartialRefund: (order: unknown) => boolean;
  refundedAmountFromOrder: (order: unknown) => number;
  appBaseUrl: (env: Record<string, string>) => string;
};
type Entitlement = { paid: boolean; admin: boolean; paidUntil: number };
const { hasAccess, accessStatus } = entitlementModule as unknown as {
  hasAccess: (identity: unknown, scope: string, opts?: Record<string, unknown>) => Promise<Entitlement>;
  accessStatus: (identity: unknown, opts?: Record<string, unknown>) => Promise<{ exam: Entitlement & { next: Record<string, number>; expiredAt: number }; constitution: Entitlement & { next: Record<string, number>; expiredAt: number } }>;
};
const { handleBillingWebhook, logBilling } = webhookModule as unknown as {
  handleBillingWebhook: Handler;
  logBilling: (entry: Record<string, unknown>) => Record<string, unknown>;
};
const { handleBillingCheckout, logBillingCheckoutError } = checkoutModule as unknown as {
  handleBillingCheckout: Handler;
  logBillingCheckoutError: (opts: Record<string, unknown>) => Record<string, unknown>;
};
const { handleExamInterview } = interviewModule as unknown as { handleExamInterview: Handler };
const { handleExamAccess } = accessModule as unknown as { handleExamAccess: Handler };
const security = securityModule as unknown as { resetIdentityCacheForTests: () => void };

const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'polar_whs_test_secret_value';
const ENV = {
  POLAR_WEBHOOK_SECRET: SECRET,
  POLAR_ACCESS_TOKEN: 'polar_oat_test',
  POLAR_SERVER: 'sandbox',
  POLAR_PRODUCT_EXAM_1M: 'prod-1m',
  POLAR_PRODUCT_EXAM_2M: 'prod-2m',
  POLAR_PRODUCT_BUNDLE_2M: 'prod-bundle',
  POLAR_PRODUCT_CONST_2M: 'prod-const',
  POLAR_PRODUCT_EXAM_3M: 'prod-3m',
  APP_URL: 'https://app.example.com/some/path',
};

type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res };
function mockRes(): Res {
  const res: Res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

/** Firestore Admin в памяти: collection/doc/get и runTransaction с get/set (чтения до записей, как в настоящем). */
function fakeDb(opts: { fail?: boolean } = {}) {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (collection: string, id: string) => ({
    path: `${collection}/${id}`,
    get: async () => snapshot(`${collection}/${id}`),
  });
  const snapshot = (path: string) => {
    if (opts.fail) throw new Error('store down');
    const data = docs.get(path);
    return { exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
  };
  return {
    docs,
    collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (opts.fail) throw new Error('store down');
      const writes: Array<[string, Record<string, unknown>]> = [];
      const tx = {
        get: async (r: { path: string }) => {
          assert.equal(writes.length, 0, 'Firestore требует все чтения до записей');
          return snapshot(r.path);
        },
        set: (r: { path: string }, data: Record<string, unknown>) => { writes.push([r.path, structuredClone(data)]); },
      };
      const result = await fn(tx);
      for (const [path, data] of writes) docs.set(path, data);
      return result;
    },
  };
}

function sign(body: string, { id = 'msg_1', timestamp = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
}

function orderEvent(type: string, data: Record<string, unknown>) {
  return JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    data: {
      id: 'order-1',
      status: 'paid',
      product_id: 'prod-1m',
      metadata: { uid: 'user-1' },
      customer_id: 'cust-1',
      total_amount: 999,
      refunded_amount: 0,
      ...data,
    },
  });
}

/** Запрос как на Vercel: тело читается из потока событиями data/end. */
function streamReq(body: string, headers: Record<string, string>, method = 'POST') {
  const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string> };
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...headers };
  setImmediate(() => {
    req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

async function deliver(
  body: string,
  db: unknown,
  { now = Date.now(), headers = sign(body) as Record<string, string>, env = ENV as Record<string, string>, raw = true } = {},
) {
  const res = mockRes();
  const req = raw
    ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, rawBody: Buffer.from(body, 'utf8') }
    : streamReq(body, headers);
  await handleBillingWebhook(req, res, { db, env, now });
  return res;
}

type AccessDoc = { examPaidUntil: number; constitutionPaidUntil: number; customerId?: string; grants: Array<Record<string, unknown>> };
function accessDoc(db: ReturnType<typeof fakeDb>, uid = 'user-1') {
  return db.docs.get(`examAccess/${uid}`) as AccessDoc | undefined;
}

/** Конец дня по Вильнюсу для даты (месяц 1-12, как пишут люди). */
const eod = (year: number, month: number, day: number) => billing.endOfDayVilnius(year, month - 1, day);
const D = (year: number, month: number, day: number, hour = 12) => Date.UTC(year, month - 1, day, hour);

const quietConsole = () => {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  beforeEach(() => {
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
  });
  afterEach(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  });
};

describe('billing: даты и сроки', () => {
  it('календарные месяцы в UTC, 31-е число прижимается к концу месяца', () => {
    assert.equal(billing.addMonthsUTC(Date.UTC(2026, 0, 15, 10), 1), Date.UTC(2026, 1, 15, 10));
    assert.equal(billing.addMonthsUTC(Date.UTC(2026, 0, 31, 10), 1), Date.UTC(2026, 1, 28, 10));
    assert.equal(billing.addMonthsUTC(Date.UTC(2028, 0, 31), 1), Date.UTC(2028, 1, 29));
    assert.equal(billing.addMonthsUTC(Date.UTC(2026, 10, 30), 3), Date.UTC(2027, 1, 28));
  });

  it('конец дня по Вильнюсу: зимой UTC+2, летом UTC+3, на границах перехода времени тоже верно', () => {
    assert.equal(new Date(eod(2027, 3, 14)).toISOString(), '2027-03-14T21:59:59.999Z', 'зима (EET)');
    assert.equal(new Date(eod(2027, 7, 14)).toISOString(), '2027-07-14T20:59:59.999Z', 'лето (EEST)');
    assert.equal(new Date(eod(2027, 3, 27)).toISOString(), '2027-03-27T21:59:59.999Z', 'накануне перехода на лето');
    assert.equal(new Date(eod(2027, 3, 28)).toISOString(), '2027-03-28T20:59:59.999Z', 'день перехода: конец дня уже по летнему времени');
    assert.equal(new Date(eod(2027, 10, 30)).toISOString(), '2027-10-30T20:59:59.999Z', 'накануне перехода на зиму');
    assert.equal(new Date(eod(2027, 10, 31)).toISOString(), '2027-10-31T21:59:59.999Z', 'день перехода: конец дня по зимнему времени');
    // следующая миллисекунда уже следующий календарный день по Вильнюсу
    for (const [y, m, d] of [[2027, 3, 14], [2027, 7, 14], [2027, 10, 31]]) {
      const end = eod(y, m, d);
      assert.deepEqual(billing.vilniusDate(end), { year: y, month: m - 1, day: d });
      assert.notDeepEqual(billing.vilniusDate(end + 1), { year: y, month: m - 1, day: d });
    }
  });

  it('одна покупка: срок — конец дня через N календарных месяцев (по дате в Вильнюсе)', () => {
    const grant = (months: number, paidAt: number) => [{ orderId: 'a', scopes: { exam: months }, paidAt }];
    assert.equal(billing.paidUntilFromGrants(grant(1, D(2027, 2, 14))), eod(2027, 3, 14));
    assert.equal(billing.paidUntilFromGrants(grant(2, D(2027, 3, 14))), eod(2027, 5, 14));
    assert.equal(billing.paidUntilFromGrants(grant(1, D(2027, 1, 31))), eod(2027, 2, 28), '31 янв + 1 мес = 28 фев');
    // 31 января 23:30 UTC — это уже 1 февраля 01:30 в Вильнюсе: считаем от даты по Вильнюсу
    assert.equal(billing.paidUntilFromGrants(grant(1, Date.UTC(2027, 0, 31, 23, 30))), eod(2027, 3, 1));
  });

  it('без дрейфа: 31 янв +1 мес, продление пока активно +1 мес = 31 марта (не 28 марта)', () => {
    const grants = [
      { orderId: 'a', scopes: { exam: 1 }, paidAt: D(2027, 1, 31) },
      { orderId: 'b', scopes: { exam: 1 }, paidAt: D(2027, 2, 10) },
    ];
    assert.equal(billing.paidUntilFromGrants(grants), eod(2027, 3, 31));
    const three = [...grants, { orderId: 'c', scopes: { exam: 2 }, paidAt: D(2027, 3, 20) }];
    assert.equal(billing.paidUntilFromGrants(three), eod(2027, 5, 31), '31 янв + 4 мес = 31 мая');
  });

  it('високосный год: 31 янв 2028 +1 = 29 фев; 29 янв +1 +1 = 29 марта; 29 фев +1 +1 = 29 апреля', () => {
    assert.equal(billing.paidUntilFromGrants([{ orderId: 'a', scopes: { exam: 1 }, paidAt: D(2028, 1, 31) }]), eod(2028, 2, 29));
    const jan29 = [
      { orderId: 'a', scopes: { exam: 1 }, paidAt: D(2028, 1, 29) },
      { orderId: 'b', scopes: { exam: 1 }, paidAt: D(2028, 2, 15) },
    ];
    assert.equal(billing.paidUntilFromGrants(jan29), eod(2028, 3, 29));
    const feb29 = [
      { orderId: 'a', scopes: { exam: 1 }, paidAt: D(2028, 2, 29) },
      { orderId: 'b', scopes: { exam: 1 }, paidAt: D(2028, 3, 5) },
    ];
    assert.equal(billing.paidUntilFromGrants(feb29), eod(2028, 4, 29));
    assert.equal(billing.paidUntilFromGrants([{ orderId: 'a', scopes: { exam: 12 }, paidAt: D(2028, 2, 29) }]), eod(2029, 2, 28));
  });

  it('продление в последний день срока продолжает период, на следующий день — начинает новый', () => {
    const first = { orderId: 'a', scopes: { exam: 1 }, paidAt: D(2027, 1, 31) };
    const until = billing.paidUntilFromGrants([first]); // конец 28 февраля
    const lastDay = { orderId: 'b', scopes: { exam: 1 }, paidAt: until - 1000 };
    assert.equal(billing.paidUntilFromGrants([first, lastDay]), eod(2027, 3, 31));
    const nextDay = { orderId: 'c', scopes: { exam: 1 }, paidAt: until + 1 };
    assert.equal(billing.paidUntilFromGrants([first, nextDay]), eod(2027, 4, 1), 'после истечения: якорь — 1 марта по Вильнюсу, итог 1 апреля');
  });

  it('продление после истечения: новый якорь с даты оплаты', () => {
    const grants = [
      { orderId: 'a', scopes: { exam: 1 }, paidAt: D(2027, 1, 31) },
      { orderId: 'b', scopes: { exam: 2 }, paidAt: D(2027, 6, 15) },
    ];
    assert.equal(billing.paidUntilFromGrants(grants), eod(2027, 8, 15));
  });

  it('возврат в середине цепочки: пересчёт из оставшихся покупок', () => {
    const a = { orderId: 'a', scopes: { exam: 1 }, paidAt: D(2027, 1, 31) };
    const b = { orderId: 'b', scopes: { exam: 1 }, paidAt: D(2027, 2, 10) };
    const c = { orderId: 'c', scopes: { exam: 1 }, paidAt: D(2027, 2, 20) };
    assert.equal(billing.paidUntilFromGrants([a, b, c]), eod(2027, 4, 30), '31 янв + 3 мес = 30 апр (прижато)');
    assert.equal(billing.paidUntilFromGrants([{ ...a, refundedAt: 1 }, b, c]), eod(2027, 4, 10), 'возврат первой: цепочка начинается с b');
    assert.equal(billing.paidUntilFromGrants([a, { ...b, refundedAt: 1 }, c]), eod(2027, 3, 31), 'возврат средней: c продолжает a');
    assert.equal(billing.paidUntilFromGrants([a, b, { ...c, refundedAt: 1 }]), eod(2027, 3, 31));
    assert.equal(billing.paidUntilFromGrants([{ ...a, refundedAt: 1 }, { ...b, refundedAt: 1 }, { ...c, refundedAt: 1 }]), 0);
  });

  it('права считаются независимо; старый grant { months } без scopes = { exam }', () => {
    const legacy = { orderId: 'old', productId: 'prod-1m', months: 1, paidAt: D(2027, 1, 10) };
    assert.deepEqual(billing.grantScopes(legacy), { exam: 1 });
    assert.deepEqual(billing.untilsFromGrants([legacy]), { exam: eod(2027, 2, 10), constitution: 0 });

    const bundle = { orderId: 'b', scopes: { exam: 2, constitution: 2 }, paidAt: D(2027, 1, 20) };
    const activeLegacy = { ...legacy, paidAt: D(2027, 1, 15) };
    assert.deepEqual(billing.untilsFromGrants([activeLegacy, bundle]), {
      exam: eod(2027, 4, 15), // 15 янв + 1 + 2 мес, цепочка не прерывалась
      constitution: eod(2027, 3, 20), // Конституция: новый период с 20 янв
    });
    assert.deepEqual(billing.untilsFromGrants([]), { exam: 0, constitution: 0 });
  });

  it('мусор в журнале игнорируется', () => {
    const now = D(2027, 1, 10);
    for (const bad of [
      { orderId: 'x', months: 'many', paidAt: now },
      { orderId: 'x', months: 0, paidAt: now },
      { orderId: 'x', scopes: {}, paidAt: now },
      { orderId: 'x', scopes: { exam: -1, constitution: 1.5 }, paidAt: now },
      { orderId: 'x', scopes: { exam: 1 }, paidAt: 'now' },
      { scopes: { exam: 1 }, paidAt: now },
      null,
    ]) {
      assert.deepEqual(billing.untilsFromGrants([bad]), { exam: 0, constitution: 0 }, JSON.stringify(bad));
    }
    assert.deepEqual(billing.untilsFromGrants('nope'), { exam: 0, constitution: 0 });
  });

  it('превью продления совпадает с итогом настоящей покупки', () => {
    const grants = [{ orderId: 'a', scopes: { exam: 1 }, paidAt: D(2027, 1, 31) }];
    const now = D(2027, 2, 10);
    assert.equal(billing.previewUntil(grants, 'exam', 1, now), eod(2027, 3, 31), 'без дрейфа');
    assert.equal(billing.previewUntil(grants, 'exam', 2, now), eod(2027, 4, 30));
    const real = billing.paidUntilFromGrants([...grants, { orderId: 'new', scopes: { exam: 2 }, paidAt: now }]);
    assert.equal(billing.previewUntil(grants, 'exam', 2, now), real);
    assert.equal(billing.previewUntil([], 'constitution', 2, now), eod(2027, 4, 10));
  });

  it('продукт -> права только по ID из окружения, включая legacy 3m', () => {
    assert.deepEqual(billing.scopesForProduct('prod-1m', ENV), { exam: 1 });
    assert.deepEqual(billing.scopesForProduct('prod-2m', ENV), { exam: 2 });
    assert.deepEqual(billing.scopesForProduct('prod-bundle', ENV), { exam: 2, constitution: 2 });
    assert.deepEqual(billing.scopesForProduct('prod-const', ENV), { constitution: 2 });
    assert.deepEqual(billing.scopesForProduct('prod-3m', ENV), { exam: 3 }, 'legacy для вебхука и возвратов');
    assert.deepEqual(billing.scopesForProduct('prod-other', ENV), {});
    assert.deepEqual(billing.scopesForProduct('', { POLAR_PRODUCT_EXAM_1M: '' }), {}, 'пустой ID в окружении не совпадает с пустым product_id');
    assert.deepEqual(billing.scopesForProduct('prod-1m', {}), {});
  });

  it('планы checkout: четыре продаваемых, 1m — алиас exam_1m, 3m и неизвестные отклоняются', () => {
    for (const plan of ['exam_1m', 'exam_2m', 'bundle_2m', 'const_2m']) assert.equal(billing.resolvePlan(plan), plan);
    assert.equal(billing.resolvePlan('1m'), 'exam_1m');
    for (const bad of ['3m', 'exam_3m', '12m', '', 'constructor', '__proto__', 'toString', undefined, null, 1, ['exam_1m'], {}]) {
      assert.equal(billing.resolvePlan(bad), '', String(bad));
    }
    assert.equal(billing.productIdForPlan('1m', ENV), 'prod-1m');
    assert.equal(billing.productIdForPlan('bundle_2m', ENV), 'prod-bundle');
    assert.equal(billing.productIdForPlan('3m', ENV), '', 'legacy-продукт купить нельзя, даже если его ID задан');
    assert.equal(billing.productIdForPlan('exam_3m', ENV), '');
  });

  it('полный и частичный возврат', () => {
    assert.equal(billing.isFullRefund({ status: 'refunded' }), true);
    assert.equal(billing.isFullRefund({ status: 'partially_refunded', total_amount: 999, refunded_amount: 999 }), true);
    assert.equal(billing.isFullRefund({ status: 'paid', total_amount: 999, refunded_amount: 1000 }), true);
    assert.equal(billing.isFullRefund({ status: 'partially_refunded', total_amount: 999, refunded_amount: 300 }), false);
    assert.equal(billing.isFullRefund({ status: 'paid', total_amount: 999, refunded_amount: 0 }), false);
    assert.equal(billing.isFullRefund(null), false);

    assert.equal(billing.isPartialRefund({ status: 'partially_refunded', total_amount: 999, refunded_amount: 300 }), true);
    assert.equal(billing.isPartialRefund({ status: 'partially_refunded' }), true);
    assert.equal(billing.isPartialRefund({ status: 'paid', total_amount: 999, refunded_amount: 300 }), true);
    assert.equal(billing.isPartialRefund({ status: 'refunded' }), false);
    assert.equal(billing.isPartialRefund({ status: 'paid', total_amount: 999, refunded_amount: 999 }), false);
    assert.equal(billing.isPartialRefund({ status: 'paid', total_amount: 999, refunded_amount: 0 }), false);
    assert.equal(billing.isPartialRefund({ status: 'paid', total_amount: 999 }), false);
    assert.equal(billing.isPartialRefund(null), false);

    assert.equal(billing.refundedAmountFromOrder({ refunded_amount: 350 }), 350);
    assert.equal(billing.refundedAmountFromOrder({ refundedAmount: 420 }), 420);
    assert.equal(billing.refundedAmountFromOrder({ refunded_amount: 0 }), 0);
    assert.equal(billing.refundedAmountFromOrder({}), 0);
    assert.equal(billing.refundedAmountFromOrder(null), 0);
  });

  it('адрес возврата: только origin из APP_URL, иначе production-домен Vercel', () => {
    assert.equal(billing.appBaseUrl(ENV), 'https://app.example.com');
    assert.equal(billing.appBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'lt.example.com' }), 'https://lt.example.com');
    assert.equal(billing.appBaseUrl({ APP_URL: 'javascript:alert(1)' }), '');
    assert.equal(billing.appBaseUrl({}), '');
  });
});

describe('/api/billing/webhook', () => {
  quietConsole();

  it('order.paid exam_1m: открывает только экзамен, заказ хранит scopes и customerId', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 14);
    const res = await deliver(orderEvent('order.paid', {}), db, { now });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'granted');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 14));
    assert.equal(accessDoc(db)?.constitutionPaidUntil, 0);
    assert.equal(accessDoc(db)?.customerId, 'cust-1');
    assert.deepEqual(accessDoc(db)?.grants, [{ orderId: 'order-1', productId: 'prod-1m', scopes: { exam: 1 }, paidAt: now, months: 1 }]);
    assert.deepEqual(db.docs.get('billingOrders/order-1'), {
      uid: 'user-1', productId: 'prod-1m', scopes: { exam: 1 }, months: 1, customerId: 'cust-1', status: 'paid', paidAt: now,
    });
  });

  it('const_2m открывает только Конституцию; bundle — оба права; exam_2m — экзамен на 2 месяца', async () => {
    const now = D(2027, 2, 14);
    const only = async (productId: string) => {
      const db = fakeDb();
      await deliver(orderEvent('order.paid', { product_id: productId }), db, { now });
      return accessDoc(db)!;
    };
    const c = await only('prod-const');
    assert.equal(c.examPaidUntil, 0);
    assert.equal(c.constitutionPaidUntil, eod(2027, 4, 14));
    const b = await only('prod-bundle');
    assert.equal(b.examPaidUntil, eod(2027, 4, 14));
    assert.equal(b.constitutionPaidUntil, eod(2027, 4, 14));
    const e2 = await only('prod-2m');
    assert.equal(e2.examPaidUntil, eod(2027, 4, 14));
    assert.equal(e2.constitutionPaidUntil, 0);
    const legacy = await only('prod-3m');
    assert.equal(legacy.examPaidUntil, eod(2027, 5, 14), 'legacy 3m по-прежнему обрабатывается вебхуком');
    assert.equal(legacy.constitutionPaidUntil, 0);
  });

  it('откат: months пишется в grant только вместе с scope exam, Constitution-only grant его не получает', async () => {
    const now = D(2027, 2, 14);
    const grantOf = async (productId: string) => {
      const db = fakeDb();
      await deliver(orderEvent('order.paid', { product_id: productId }), db, { now });
      return accessDoc(db)!.grants[0];
    };
    assert.equal((await grantOf('prod-1m')).months, 1);
    assert.equal((await grantOf('prod-2m')).months, 2);
    const bundle = await grantOf('prod-bundle');
    assert.equal(bundle.months, 2);
    assert.deepEqual(bundle.scopes, { exam: 2, constitution: 2 });
    const c = await grantOf('prod-const');
    assert.equal('months' in c, false, 'старый код прочитал бы months как доступ к экзамену');
    assert.deepEqual(c.scopes, { constitution: 2 });
    // Новый код по-прежнему опирается на scopes, а не на months.
    assert.equal(billing.paidUntilFromGrants([c], 'exam'), 0);
    assert.equal(billing.paidUntilFromGrants([c], 'constitution'), eod(2027, 4, 14));
  });

  it('bundle продлевает оба права независимо, когда одно ещё активно, а другое нет', async () => {
    const db = fakeDb();
    // экзамен куплен 31 января на месяц и ещё активен, Конституция не куплена
    await deliver(orderEvent('order.paid', { id: 'o-exam', product_id: 'prod-1m' }), db, { now: D(2027, 1, 31) });
    await deliver(orderEvent('order.paid', { id: 'o-bundle', product_id: 'prod-bundle' }), db, { now: D(2027, 2, 10) });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 30), 'экзамен: 31 янв + 1 + 2 мес = 30 апр (31-е прижато только в конце)');
    assert.equal(accessDoc(db)?.constitutionPaidUntil, eod(2027, 4, 10), 'Конституция: новый период с 10 фев');

    // Конституция истекла, экзамен активен: покупка const_2m не трогает экзамен
    await deliver(orderEvent('order.paid', { id: 'o-const', product_id: 'prod-const' }), db, { now: D(2027, 6, 1) });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 30));
    assert.equal(accessDoc(db)?.constitutionPaidUntil, eod(2027, 8, 1));
  });

  it('тело читается из потока (как на Vercel), подпись сверяется по сырым байтам', async () => {
    const db = fakeDb();
    const body = orderEvent('order.paid', { product_id: 'prod-3m' }).replace('{', '{ ');
    const res = await deliver(body, db, { raw: false });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'granted');
  });

  it('неверная подпись -> 403 и никаких записей', async () => {
    const db = fakeDb();
    const body = orderEvent('order.paid', {});
    const cases: Array<Record<string, string>> = [
      sign(body, { secret: 'polar_whs_wrong' }),
      sign(orderEvent('order.paid', { product_id: 'prod-3m' })),
      { ...sign(body), 'webhook-signature': 'v1,AAAA' },
      { 'webhook-id': 'msg_1', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)) },
      sign(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      {},
    ];
    for (const headers of cases) {
      const res = await deliver(body, db, { headers });
      assert.equal(res.statusCode, 403, JSON.stringify(headers));
      assert.equal(res.body.code, 'INVALID_SIGNATURE');
    }
    const tampered = body.replace('user-1', 'attacker');
    const res = await deliver(tampered, db, { headers: sign(body) });
    assert.equal(res.statusCode, 403);
    assert.equal(db.docs.size, 0);
  });

  it('повтор order.paid не продлевает второй раз (bundle тоже)', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    const body = orderEvent('order.paid', { product_id: 'prod-bundle' });
    await deliver(body, db, { now });
    const first = structuredClone(accessDoc(db));
    const again = await deliver(body, db, { now: now + DAY, headers: sign(body, { id: 'msg_2' }) });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.outcome, 'duplicate');
    assert.deepEqual(accessDoc(db), first);
    assert.equal(accessDoc(db)?.grants.length, 1);
  });

  it('полный возврат bundle забирает оба права; повтор возврата и повтор оплаты ничего не меняют', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    await deliver(orderEvent('order.paid', { product_id: 'prod-bundle' }), db, { now });
    const res = await deliver(orderEvent('order.refunded', { product_id: 'prod-bundle', status: 'refunded', refunded_amount: 1799 }), db, { now: now + DAY });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'revoked');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal(accessDoc(db)?.constitutionPaidUntil, 0);
    assert.equal((db.docs.get('billingOrders/order-1') as { status: string }).status, 'refunded');
    assert.equal(accessDoc(db)?.customerId, 'cust-1', 'customerId переживает пересчёт');

    const again = await deliver(orderEvent('order.refunded', { status: 'refunded' }), db, { now: now + 2 * DAY });
    assert.equal(again.body.outcome, 'duplicate');
    const replayPaid = await deliver(orderEvent('order.paid', { product_id: 'prod-bundle' }), db, { now: now + 3 * DAY });
    assert.equal(replayPaid.body.outcome, 'duplicate');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal(accessDoc(db)?.constitutionPaidUntil, 0);
  });

  it('возврат по правам: возврат bundle не трогает отдельно купленный экзамен, а const-покупка не влияет на экзамен', async () => {
    const db = fakeDb();
    await deliver(orderEvent('order.paid', { id: 'o-exam', product_id: 'prod-2m' }), db, { now: D(2027, 2, 1) });
    await deliver(orderEvent('order.paid', { id: 'o-bundle', product_id: 'prod-bundle' }), db, { now: D(2027, 2, 5) });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 6, 1), '2 + 2 мес от 1 фев');
    assert.equal(accessDoc(db)?.constitutionPaidUntil, eod(2027, 4, 5));

    await deliver(orderEvent('order.refunded', { id: 'o-bundle', product_id: 'prod-bundle', status: 'refunded' }), db, { now: D(2027, 2, 6) });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 1), 'остался только exam_2m');
    assert.equal(accessDoc(db)?.constitutionPaidUntil, 0);

    await deliver(orderEvent('order.paid', { id: 'o-const', product_id: 'prod-const' }), db, { now: D(2027, 2, 7) });
    await deliver(orderEvent('order.refunded', { id: 'o-exam', product_id: 'prod-2m', status: 'refunded' }), db, { now: D(2027, 2, 8) });
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal(accessDoc(db)?.constitutionPaidUntil, eod(2027, 4, 7), 'возврат экзамена не трогает Конституцию');
  });

  it('возврат в середине цепочки пересчитывает срок без дрейфа', async () => {
    const db = fakeDb();
    await deliver(orderEvent('order.paid', { id: 'a', product_id: 'prod-1m' }), db, { now: D(2027, 1, 31) });
    await deliver(orderEvent('order.paid', { id: 'b', product_id: 'prod-1m' }), db, { now: D(2027, 2, 10) });
    await deliver(orderEvent('order.paid', { id: 'c', product_id: 'prod-1m' }), db, { now: D(2027, 2, 20) });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 30));
    await deliver(orderEvent('order.refunded', { id: 'b', product_id: 'prod-1m', status: 'refunded' }), db, { now: D(2027, 2, 21) });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 31));
  });

  it('возврат раньше оплаты: поздний order.paid доступ не открывает', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    const refund = await deliver(orderEvent('order.refunded', { status: 'refunded' }), db, { now });
    assert.equal(refund.body.outcome, 'refund_before_paid');
    const paid = await deliver(orderEvent('order.paid', { product_id: 'prod-bundle' }), db, { now: now + 1000 });
    assert.equal(paid.body.outcome, 'duplicate');
    assert.equal(accessDoc(db), undefined);
  });

  it('старый документ (grant с months, без scopes и без constitutionPaidUntil) читается и не мигрируется при чтении', async () => {
    const db = fakeDb();
    const paidAt = D(2027, 1, 10);
    const legacyDoc = { examPaidUntil: Date.UTC(2027, 1, 10, 12), grants: [{ orderId: 'old', productId: 'prod-1m', months: 1, paidAt }], updatedAt: paidAt };
    db.docs.set('examAccess/user-1', structuredClone(legacyDoc));
    const identity = { uid: 'user-1' };
    const before = D(2027, 1, 20);
    assert.deepEqual(await hasAccess(identity, 'exam', { db, now: before }), { paid: true, admin: false, paidUntil: legacyDoc.examPaidUntil });
    assert.equal((await hasAccess(identity, 'constitution', { db, now: before })).paid, false);
    assert.deepEqual(db.docs.get('examAccess/user-1'), legacyDoc, 'чтение ничего не пишет');

    // новая покупка поверх старой: старый grant остаётся как есть и продолжает цепочку
    await deliver(orderEvent('order.paid', { id: 'new', product_id: 'prod-bundle' }), db, { now: D(2027, 1, 20) });
    const doc = accessDoc(db)!;
    assert.deepEqual(doc.grants[0], legacyDoc.grants[0]);
    assert.equal(doc.examPaidUntil, eod(2027, 4, 10), '10 янв + 1 + 2 мес');
    assert.equal(doc.constitutionPaidUntil, eod(2027, 3, 20));

    // возврат старого заказа без записи в billingOrders и без uid в metadata — это refund_before_paid, ничего не ломает
    const res = await deliver(orderEvent('order.refunded', { id: 'old', metadata: {}, status: 'refunded' }), db, { now: D(2027, 1, 21) });
    assert.equal(res.body.outcome, 'refund_before_paid');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 10));
  });

  it('частичный возврат доступ не трогает и сохраняет запись в журнале billingOrders', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    await deliver(orderEvent('order.paid', {}), db, { now });
    const res = await deliver(orderEvent('order.refunded', { status: 'partially_refunded', refunded_amount: 200 }), db, { now: now + 5000 });
    assert.equal(res.body.outcome, 'partial_refund_kept');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 7));
    assert.deepEqual(db.docs.get('billingOrders/order-1'), {
      uid: 'user-1',
      productId: 'prod-1m',
      scopes: { exam: 1 },
      months: 1,
      customerId: 'cust-1',
      status: 'partially_refunded',
      paidAt: now,
      refundedAmount: 200,
      partiallyRefundedAt: now + 5000,
    });
  });

  it('order.updated: полный возврат по статусу (refunded) отзывает права аналогично order.refunded', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    await deliver(orderEvent('order.paid', {}), db, { now });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 7));

    const res = await deliver(orderEvent('order.updated', { status: 'refunded', refunded_amount: 999 }), db, { now: now + DAY });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'revoked');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal((db.docs.get('billingOrders/order-1') as { status: string }).status, 'refunded');

    // повторный order.updated — идемпотентный дубликат
    const dup = await deliver(orderEvent('order.updated', { status: 'refunded', refunded_amount: 999 }), db, { now: now + 2 * DAY });
    assert.equal(dup.statusCode, 200);
    assert.equal(dup.body.outcome, 'duplicate');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
  });

  it('order.updated: полный возврат по сумме (refunded_amount >= total_amount) отзывает права', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    await deliver(orderEvent('order.paid', { total_amount: 1500 }), db, { now });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 7));

    const res = await deliver(orderEvent('order.updated', { total_amount: 1500, refunded_amount: 1500, status: 'paid' }), db, { now: now + DAY });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'revoked');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal((db.docs.get('billingOrders/order-1') as { status: string }).status, 'refunded');
  });

  it('order.updated: частичный возврат оставляет доступ активным и записывает в журнал billingOrders', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    await deliver(orderEvent('order.paid', { total_amount: 1000 }), db, { now });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 7));

    const res = await deliver(orderEvent('order.updated', { total_amount: 1000, refunded_amount: 400, status: 'partially_refunded' }), db, { now: now + 3000 });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'partial_refund_kept');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 7));
    assert.deepEqual(db.docs.get('billingOrders/order-1'), {
      uid: 'user-1',
      productId: 'prod-1m',
      scopes: { exam: 1 },
      months: 1,
      customerId: 'cust-1',
      status: 'partially_refunded',
      paidAt: now,
      refundedAmount: 400,
      partiallyRefundedAt: now + 3000,
    });

    // дубликат с той же суммой возврата — duplicate
    const dup = await deliver(orderEvent('order.updated', { total_amount: 1000, refunded_amount: 400, status: 'partially_refunded' }), db, { now: now + 6000 });
    assert.equal(dup.statusCode, 200);
    assert.equal(dup.body.outcome, 'duplicate');
  });

  it('order.updated: без возврата (обычное обновление заказа) игнорируется (200, ignored: true)', async () => {
    const db = fakeDb();
    const now = D(2027, 2, 7);
    await deliver(orderEvent('order.paid', {}), db, { now });
    const orderBefore = structuredClone(db.docs.get('billingOrders/order-1'));
    const accessBefore = structuredClone(db.docs.get('examAccess/user-1'));

    const res = await deliver(orderEvent('order.updated', { total_amount: 999, refunded_amount: 0, status: 'paid' }), db, { now: now + DAY });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.received, true);
    assert.equal(res.body.ignored, true);
    assert.deepEqual(db.docs.get('billingOrders/order-1'), orderBefore);
    assert.deepEqual(db.docs.get('examAccess/user-1'), accessBefore);
  });

  it('порядок событий: ранний частичный возврат через order.refunded до оплаты сохраняет права при позднем order.paid', async () => {
    const db = fakeDb();
    const tRefund = D(2027, 2, 7);
    const tPaid = D(2027, 2, 8);

    // 1. Частичный возврат приходит РАНО (до оплаты)
    const early = await deliver(orderEvent('order.refunded', { id: 'ord_early_part', status: 'partially_refunded', refunded_amount: 350 }), db, { now: tRefund });
    assert.equal(early.statusCode, 200);
    assert.equal(early.body.outcome, 'partial_refund_before_paid');
    assert.equal(accessDoc(db), undefined, 'прав ещё нет');
    assert.deepEqual(db.docs.get('billingOrders/ord_early_part'), {
      uid: 'user-1',
      status: 'partially_refunded',
      refundedAmount: 350,
      partiallyRefundedAt: tRefund,
    });

    // 2. Поздняя оплата order.paid открывает доступ и сохраняет запись о частичном возврате
    const paid = await deliver(orderEvent('order.paid', { id: 'ord_early_part', product_id: 'prod-1m' }), db, { now: tPaid });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.body.outcome, 'granted');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 8));
    assert.deepEqual(db.docs.get('billingOrders/ord_early_part'), {
      uid: 'user-1',
      productId: 'prod-1m',
      scopes: { exam: 1 },
      months: 1,
      customerId: 'cust-1',
      status: 'partially_refunded',
      paidAt: tPaid,
      refundedAmount: 350,
      partiallyRefundedAt: tRefund,
    });

    // 3. Повтор order.paid — дубликат
    const dupPaid = await deliver(orderEvent('order.paid', { id: 'ord_early_part' }), db, { now: tPaid + 1000 });
    assert.equal(dupPaid.body.outcome, 'duplicate');
  });

  it('порядок событий: ранний частичный возврат через order.updated до оплаты сохраняет права при позднем order.paid', async () => {
    const db = fakeDb();
    const tRefund = D(2027, 2, 7);
    const tPaid = D(2027, 2, 8);

    const early = await deliver(orderEvent('order.updated', { id: 'ord_early_upd', total_amount: 1000, refunded_amount: 250, status: 'paid' }), db, { now: tRefund });
    assert.equal(early.statusCode, 200);
    assert.equal(early.body.outcome, 'partial_refund_before_paid');
    assert.equal(accessDoc(db), undefined);

    const paid = await deliver(orderEvent('order.paid', { id: 'ord_early_upd', product_id: 'prod-bundle' }), db, { now: tPaid });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.body.outcome, 'granted');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 8));
    assert.equal(accessDoc(db)?.constitutionPaidUntil, eod(2027, 4, 8));
    assert.deepEqual(db.docs.get('billingOrders/ord_early_upd'), {
      uid: 'user-1',
      productId: 'prod-bundle',
      scopes: { exam: 2, constitution: 2 },
      months: 2,
      customerId: 'cust-1',
      status: 'partially_refunded',
      paidAt: tPaid,
      refundedAmount: 250,
      partiallyRefundedAt: tRefund,
    });
  });

  it('порядок событий: ранний полный возврат через order.updated до оплаты блокирует поздний order.paid', async () => {
    const db = fakeDb();
    const tRefund = D(2027, 2, 7);
    const tPaid = D(2027, 2, 8);

    const refund = await deliver(orderEvent('order.updated', { id: 'ord_early_full', status: 'refunded', refunded_amount: 1000, total_amount: 1000 }), db, { now: tRefund });
    assert.equal(refund.statusCode, 200);
    assert.equal(refund.body.outcome, 'refund_before_paid');

    const paid = await deliver(orderEvent('order.paid', { id: 'ord_early_full' }), db, { now: tPaid });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.body.outcome, 'duplicate');
    assert.equal(accessDoc(db), undefined);
  });

  it('порядок событий: оплата -> частичный возврат -> последующий полный возврат отзывает доступ', async () => {
    const db = fakeDb();
    const t1 = D(2027, 2, 1);
    const t2 = D(2027, 2, 5);
    const t3 = D(2027, 2, 10);
    const t4 = D(2027, 2, 12);

    // 1. Оплата
    await deliver(orderEvent('order.paid', { id: 'o-seq', product_id: 'prod-2m' }), db, { now: t1 });
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 1));

    // 2. Частичный возврат: доступ сохранён
    const part = await deliver(orderEvent('order.updated', { id: 'o-seq', total_amount: 1500, refunded_amount: 500, status: 'partially_refunded' }), db, { now: t2 });
    assert.equal(part.body.outcome, 'partial_refund_kept');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 4, 1));
    assert.equal((db.docs.get('billingOrders/o-seq') as { status: string }).status, 'partially_refunded');

    // 3. Полный возврат: доступ отозван
    const full = await deliver(orderEvent('order.refunded', { id: 'o-seq', status: 'refunded' }), db, { now: t3 });
    assert.equal(full.body.outcome, 'revoked');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal((db.docs.get('billingOrders/o-seq') as { status: string }).status, 'refunded');

    // 4. Запоздавший дубликат частичного возврата (out of order) не может вернуть доступ
    const latePart = await deliver(orderEvent('order.updated', { id: 'o-seq', total_amount: 1500, refunded_amount: 500 }), db, { now: t4 });
    assert.equal(latePart.body.outcome, 'duplicate');
    assert.equal(accessDoc(db)?.examPaidUntil, 0);
    assert.equal((db.docs.get('billingOrders/o-seq') as { status: string }).status, 'refunded');
  });

  it('порядок событий: частичный возврат с увеличением суммы обновляет журнал и оставляет дату первой части', async () => {
    const db = fakeDb();
    const t1 = D(2027, 2, 1);
    const t2 = D(2027, 2, 5);
    const t3 = D(2027, 2, 10);

    await deliver(orderEvent('order.paid', { id: 'o-incr' }), db, { now: t1 });

    // Первый частичный возврат
    await deliver(orderEvent('order.updated', { id: 'o-incr', total_amount: 1000, refunded_amount: 300, status: 'partially_refunded' }), db, { now: t2 });
    const order1 = db.docs.get('billingOrders/o-incr') as { refundedAmount: number; partiallyRefundedAt: number };
    assert.equal(order1.refundedAmount, 300);
    assert.equal(order1.partiallyRefundedAt, t2);

    // Дополнительный частичный возврат (увеличение суммы)
    const res2 = await deliver(orderEvent('order.updated', { id: 'o-incr', total_amount: 1000, refunded_amount: 700, status: 'partially_refunded' }), db, { now: t3 });
    assert.equal(res2.body.outcome, 'partial_refund_kept');
    const order2 = db.docs.get('billingOrders/o-incr') as { refundedAmount: number; partiallyRefundedAt: number };
    assert.equal(order2.refundedAmount, 700);
    assert.equal(order2.partiallyRefundedAt, t2, 'исходная дата частичного возврата сохраняется');
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 1), 'доступ не затронут');
  });

  it('порядок событий: ранний частичный возврат, затем полный возврат до оплаты', async () => {
    const db = fakeDb();
    const t1 = D(2027, 2, 1);
    const t2 = D(2027, 2, 5);
    const t3 = D(2027, 2, 10);

    // 1. Ранний частичный возврат
    const part = await deliver(orderEvent('order.updated', { id: 'o-early-both', total_amount: 1000, refunded_amount: 300 }), db, { now: t1 });
    assert.equal(part.body.outcome, 'partial_refund_before_paid');

    // 2. Полный возврат до оплаты
    const full = await deliver(orderEvent('order.refunded', { id: 'o-early-both', status: 'refunded' }), db, { now: t2 });
    assert.equal(full.body.outcome, 'refund_before_paid');
    assert.equal((db.docs.get('billingOrders/o-early-both') as { status: string }).status, 'refunded');

    // 3. Запоздавшая оплата
    const paid = await deliver(orderEvent('order.paid', { id: 'o-early-both' }), db, { now: t3 });
    assert.equal(paid.body.outcome, 'duplicate');
    assert.equal(accessDoc(db), undefined);
  });

  it('пересчёт прав при order.updated full refund: отзывает только свои scopes и пересчитывает paidUntil', async () => {
    const db = fakeDb();
    // Покупка 1: exam_1m на 1 месяц от 1 февраля -> до 1 марта
    await deliver(orderEvent('order.paid', { id: 'o-multi-1', product_id: 'prod-1m' }), db, { now: D(2027, 2, 1) });
    // Покупка 2: bundle_2m на 2 месяца от 10 февраля -> exam до 1 мая, const до 10 апреля
    await deliver(orderEvent('order.paid', { id: 'o-multi-2', product_id: 'prod-bundle' }), db, { now: D(2027, 2, 10) });

    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 5, 1));
    assert.equal(accessDoc(db)?.constitutionPaidUntil, eod(2027, 4, 10));

    // Полный возврат bundle через order.updated
    const res = await deliver(orderEvent('order.updated', { id: 'o-multi-2', product_id: 'prod-bundle', status: 'refunded', refunded_amount: 1799 }), db, { now: D(2027, 2, 15) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'revoked');

    // Экзамен сократился до срока первой покупки (o-multi-1 не пострадал)
    assert.equal(accessDoc(db)?.examPaidUntil, eod(2027, 3, 1));
    // Конституция полностью отозвана (других покупок Конституции не было)
    assert.equal(accessDoc(db)?.constitutionPaidUntil, 0);

    // В журнале первая покупка осталась paid, вторая — refunded
    assert.equal((db.docs.get('billingOrders/o-multi-1') as { status: string }).status, 'paid');
    assert.equal((db.docs.get('billingOrders/o-multi-2') as { status: string }).status, 'refunded');
  });

  it('прочие события, чужой продукт и заказ без uid — 200 без записей', async () => {
    const db = fakeDb();
    const checkoutCreated = JSON.stringify({ type: 'checkout.created', timestamp: new Date().toISOString(), data: { id: 'c1' } });
    const unknownType = JSON.stringify({ type: 'something.new', timestamp: new Date().toISOString(), data: {} });
    for (const body of [
      checkoutCreated,
      unknownType,
      orderEvent('order.created', {}),
      orderEvent('order.paid', { product_id: 'prod-other' }),
      orderEvent('order.paid', { metadata: {} }),
      orderEvent('order.paid', { metadata: { uid: 'a/b' } }),
    ]) {
      const res = await deliver(body, db);
      assert.equal(res.statusCode, 200, body);
    }
    assert.equal(db.docs.size, 0);
  });

  it('хранилище недоступно -> 503 (Polar повторит доставку)', async () => {
    const res = await deliver(orderEvent('order.paid', {}), fakeDb({ fail: true }));
    assert.equal(res.statusCode, 503);
    const noDb = await deliver(orderEvent('order.paid', {}), null);
    assert.equal(noDb.statusCode, 503);
  });

  it('без POLAR_WEBHOOK_SECRET -> 503, не GET -> 405, битый JSON с верной подписью -> 400', async () => {
    const body = orderEvent('order.paid', {});
    const noSecret = await deliver(body, fakeDb(), { env: { ...ENV, POLAR_WEBHOOK_SECRET: '' } });
    assert.equal(noSecret.statusCode, 503);

    const res = mockRes();
    await handleBillingWebhook({ method: 'GET', headers: {} }, res, { db: fakeDb(), env: ENV });
    assert.equal(res.statusCode, 405);

    const broken = await deliver('{not json', fakeDb(), { headers: sign('{not json') });
    assert.equal(broken.statusCode, 400);
  });
});

describe('доступ по правам: exam и constitution независимы, examAdmin = оба', () => {
  quietConsole();

  const lookupUser = { localId: 'user-1', email: 'u@example.com', emailVerified: true };
  const user = { uid: 'user-1', examAdminClaim: false } as const;
  const admin = { uid: 'user-1', examAdminClaim: true } as const;

  function dbWith(doc: Record<string, unknown>) {
    const db = fakeDb();
    db.docs.set('examAccess/user-1', { grants: [], ...doc });
    return db;
  }

  it('действующий срок — оплачен, истёкший — нет, по каждому праву отдельно', async () => {
    const now = D(2027, 2, 7);
    const none = { paid: false, admin: false, paidUntil: 0 };
    const db = dbWith({ examPaidUntil: now + DAY, constitutionPaidUntil: 0 });
    assert.deepEqual(await hasAccess(user, 'exam', { db, now }), { paid: true, admin: false, paidUntil: now + DAY });
    assert.deepEqual(await hasAccess(user, 'constitution', { db, now }), none);

    const db2 = dbWith({ examPaidUntil: 0, constitutionPaidUntil: now + DAY });
    assert.deepEqual(await hasAccess(user, 'exam', { db: db2, now }), none);
    assert.deepEqual(await hasAccess(user, 'constitution', { db: db2, now }), { paid: true, admin: false, paidUntil: now + DAY });

    assert.deepEqual(await hasAccess(user, 'exam', { db: dbWith({ examPaidUntil: now }), now }), none, 'граница: срок == сейчас — уже не оплачен');
    assert.deepEqual(await hasAccess(user, 'exam', { db: dbWith({ examPaidUntil: now - 1 }), now }), none);
    assert.deepEqual(await hasAccess(user, 'exam', { db: fakeDb(), now }), none);
    assert.deepEqual(await hasAccess(user, 'unknown-scope', { db, now }), none);
  });

  it('не доверяет localId и customAttributes без examAdminClaim', async () => {
    const now = D(2027, 2, 7);
    const db = dbWith({ examPaidUntil: now + DAY });
    const forged = { localId: 'user-1', customAttributes: JSON.stringify({ examAdmin: true }) };
    assert.deepEqual(await hasAccess(forged, 'exam', { db, now }), { paid: false, admin: false, paidUntil: 0 });
    const uidOnlyForged = { uid: 'user-1', customAttributes: JSON.stringify({ examAdmin: true }) };
    const fromStore = await hasAccess(uidOnlyForged, 'exam', { db, now });
    assert.equal(fromStore.admin, false, 'examAdminClaim не задан — admin только через getIdentity');
    assert.equal(fromStore.paid, true);
    assert.equal(fromStore.paidUntil, now + DAY);
  });

  it('claim examAdmin даёт оба права без оплаты и без хранилища; сбой хранилища — не оплачено', async () => {
    for (const scope of ['exam', 'constitution']) {
      assert.equal((await hasAccess(admin, scope, { db: null })).paid, true);
      assert.equal((await hasAccess(admin, scope, { db: fakeDb({ fail: true }) })).paid, true);
      assert.equal((await hasAccess(user, scope, { db: fakeDb({ fail: true }) })).paid, false);
      assert.equal((await hasAccess(user, scope, { db: null })).paid, false);
      assert.equal((await hasAccess({}, scope, { db: dbWith({ examPaidUntil: Date.now() + DAY, constitutionPaidUntil: Date.now() + DAY }) })).paid, false);
    }
  });

  it('accessStatus: оба права за одно чтение, next — превью продления на 1 и 2 месяца', async () => {
    const now = D(2027, 2, 10);
    const grants = [{ orderId: 'a', scopes: { exam: 1 }, paidAt: D(2027, 1, 31) }];
    const db = dbWith({ examPaidUntil: eod(2027, 2, 28), constitutionPaidUntil: 0, grants });
    const status = await accessStatus(user, { db, now });
    assert.equal(status.exam.paid, true);
    assert.equal(status.exam.paidUntil, eod(2027, 2, 28));
    assert.deepEqual(status.exam.next, { 1: eod(2027, 3, 31), 2: eod(2027, 4, 30) });
    assert.deepEqual(status.constitution, { paid: false, admin: false, paidUntil: 0, next: {}, expiredAt: 0 });
    const lapsed = await accessStatus(user, { db: dbWith({ examPaidUntil: now - DAY, constitutionPaidUntil: 0 }), now });
    assert.equal(lapsed.exam.paid, false);
    assert.equal(lapsed.exam.expiredAt, now - DAY, 'истёкший срок помечается, прогресс не трогаем');
    assert.equal(lapsed.constitution.expiredAt, 0);
    const adminStatus = await accessStatus(admin, { db: null, now });
    assert.equal(adminStatus.exam.paid && adminStatus.constitution.paid, true);
    const down = await accessStatus(user, { db: fakeDb({ fail: true }), now });
    assert.equal(down.exam.paid || down.constitution.paid, false);
  });

  it('interview и access: exam-покупатель, const-покупатель и истечение', async () => {
    const now = D(2027, 2, 7);
    const lookup = async () => lookupUser;
    const call = async (handler: Handler, db: unknown, at: number) => {
      const res = mockRes();
      await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res, { lookup, db, now: at, interviewPayload: (paid: boolean) => ({ paid }) });
      return res;
    };
    const examOnly = dbWith({ examPaidUntil: now + DAY, constitutionPaidUntil: 0 });
    const constOnly = dbWith({ examPaidUntil: 0, constitutionPaidUntil: now + DAY });

    assert.deepEqual((await call(handleExamInterview, examOnly, now)).body, { paid: true, paidUntil: now + DAY });
    assert.deepEqual((await call(handleExamInterview, examOnly, now + 2 * DAY)).body, { paid: false, paidUntil: 0 });
    assert.deepEqual((await call(handleExamInterview, constOnly, now)).body, { paid: false, paidUntil: 0 }, 'const-покупатель не получает платный экзамен');

    const examAccess = await call(handleExamAccess, examOnly, now);
    assert.equal(examAccess.statusCode, 200);
    assert.equal(examAccess.body.ok, true);
    assert.equal(examAccess.body.uid, 'user-1');
    assert.equal(examAccess.body.paidUntil, now + DAY, 'старое поле = срок exam');
    assert.equal(examAccess.body.exam.paid, true);
    assert.equal(examAccess.body.exam.paidUntil, now + DAY);
    assert.equal(examAccess.body.constitution.paid, false);

    const constAccess = await call(handleExamAccess, constOnly, now);
    assert.equal(constAccess.statusCode, 200);
    assert.equal(constAccess.body.exam.paid, false);
    assert.equal(constAccess.body.constitution.paid, true);
    assert.equal(constAccess.body.constitution.paidUntil, now + DAY);
    assert.equal(constAccess.body.paidUntil, 0);

    const expired = await call(handleExamAccess, examOnly, now + 2 * DAY);
    assert.equal(expired.statusCode, 403);
    assert.equal(expired.body.code, 'FORBIDDEN');
    assert.equal(expired.body.exam.paid, false, '403 всё равно несёт статус для UI');
    assert.equal(expired.body.constitution.paid, false);
  });
});

describe('/api/billing/checkout', () => {
  quietConsole();
  const originalFetch = globalThis.fetch;
  const users: Record<string, unknown> = {
    'tok-user': { localId: 'user-1', email: 'Buyer@Example.com', emailVerified: true },
    'tok-other': { localId: 'user-2', email: 'other@example.com', emailVerified: true },
    'tok-none': { localId: 'user-3', email: 'none@example.com', emailVerified: true },
  };

  beforeEach(() => {
    security.resetIdentityCacheForTests();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const idToken = JSON.parse(String(init?.body || '{}')).idToken;
      const found = users[idToken];
      return found ? ({ ok: true, json: async () => ({ users: [found] }) } as Response) : ({ ok: false } as Response);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const call = async (body: unknown, auth?: string, extra: Record<string, unknown> = {}) => {
    const calls: Array<Record<string, unknown>> = [];
    const res = mockRes();
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    await handleBillingCheckout({ method: 'POST', headers, body }, res, {
      env: ENV,
      createCheckout: async (args: Record<string, unknown>) => {
        calls.push(args);
        return 'https://sandbox.polar.sh/checkout/abc';
      },
      ...extra,
    });
    return { res, calls };
  };

  it('без токена или с невалидным токеном — 401, Polar не вызывается', async () => {
    for (const auth of [undefined, 'Bearer tok-bad']) {
      const { res, calls } = await call({ plan: 'exam_1m' }, auth);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'UNAUTHENTICATED');
      assert.equal(calls.length, 0);
    }
  });

  it('четыре тарифа -> свои продукты; uid и почта из токена, uid и productId из тела игнорируются', async () => {
    const expected: Record<string, string> = { exam_1m: 'prod-1m', exam_2m: 'prod-2m', bundle_2m: 'prod-bundle', const_2m: 'prod-const', '1m': 'prod-1m' };
    for (const [plan, productId] of Object.entries(expected)) {
      const { res, calls } = await call({ plan, uid: 'user-2', productId: 'prod-evil' }, 'Bearer tok-user');
      assert.equal(res.statusCode, 200, plan);
      assert.deepEqual(res.body, { url: 'https://sandbox.polar.sh/checkout/abc' });
      assert.deepEqual(calls, [{
        productId,
        uid: 'user-1',
        email: 'buyer@example.com',
        successUrl: 'https://app.example.com/?billing=success#exam',
        returnUrl: 'https://app.example.com/#exam',
      }], plan);
    }
  });

  it('возврат туда, откуда пришёл: from=constitution -> #constitution, from=settings -> #settings, мусор -> #exam', async () => {
    const fromConst = await call({ plan: 'const_2m', from: 'constitution' }, 'Bearer tok-user');
    assert.equal(fromConst.calls[0].successUrl, 'https://app.example.com/?billing=success#constitution');
    assert.equal(fromConst.calls[0].returnUrl, 'https://app.example.com/#constitution');
    const fromSettings = await call({ plan: 'exam_1m', from: 'settings' }, 'Bearer tok-user');
    assert.equal(fromSettings.calls[0].successUrl, 'https://app.example.com/?billing=success#settings');
    assert.equal(fromSettings.calls[0].returnUrl, 'https://app.example.com/#settings');
    for (const from of ['https://evil.example.com', '#x', 'constructor', 5, ['constitution'], undefined]) {
      const { calls } = await call({ plan: 'exam_1m', from }, 'Bearer tok-user');
      assert.equal(calls[0].returnUrl, 'https://app.example.com/#exam', String(from));
    }
  });

  it('3m, legacy exam_3m и неизвестный тариф — 400, Polar не вызывается; не настроено — 503; ошибка Polar — 502; GET — 405', async () => {
    for (const body of [{ plan: '3m' }, { plan: 'exam_3m' }, { plan: '12m' }, {}, 'not-json', { plan: ['exam_1m'] }, { plan: 'constructor' }]) {
      const { res, calls } = await call(body, 'Bearer tok-user');
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(calls.length, 0);
    }
    for (const env of [
      { ...ENV, POLAR_PRODUCT_EXAM_1M: '' },
      { ...ENV, POLAR_ACCESS_TOKEN: '' },
      { ...ENV, POLAR_SERVER: 'live' },
      { ...ENV, APP_URL: '' },
    ]) {
      const { res, calls } = await call({ plan: 'exam_1m' }, 'Bearer tok-other', { env });
      assert.equal(res.statusCode, 503);
      assert.equal(calls.length, 0);
    }
    const notConfigured = await call({ plan: 'bundle_2m' }, 'Bearer tok-other', { env: { ...ENV, POLAR_PRODUCT_BUNDLE_2M: '' } });
    assert.equal(notConfigured.res.statusCode, 503);
    const failing = await call({ plan: 'exam_1m' }, 'Bearer tok-other', { createCheckout: async () => { throw new Error('polar down'); } });
    assert.equal(failing.res.statusCode, 502);

    const res = mockRes();
    await handleBillingCheckout({ method: 'GET', headers: {} }, res, { env: ENV });
    assert.equal(res.statusCode, 405);
  });

  describe('action: portal', () => {
    function portalDb() {
      const db = fakeDb();
      db.docs.set('examAccess/user-1', { examPaidUntil: 1, grants: [], customerId: 'cust-user-1' });
      db.docs.set('examAccess/user-2', { examPaidUntil: 1, grants: [], customerId: 'cust-user-2' });
      return db;
    }
    const portal = async (auth: string | undefined, body: unknown, extra: Record<string, unknown> = {}) => {
      const portalCalls: Array<Record<string, unknown>> = [];
      const checkoutCalls: Array<Record<string, unknown>> = [];
      const res = mockRes();
      const headers: Record<string, string> = {};
      if (auth) headers.authorization = auth;
      await handleBillingCheckout({ method: 'POST', headers, body }, res, {
        env: ENV,
        db: portalDb(),
        createCheckout: async (args: Record<string, unknown>) => { checkoutCalls.push(args); return 'https://x'; },
        createPortal: async (args: Record<string, unknown>) => {
          portalCalls.push(args);
          return `https://sandbox.polar.sh/portal/${String(args.customerId)}`;
        },
        findCustomerId: async () => '',
        ...extra,
      });
      return { res, portalCalls, checkoutCalls };
    };

    it('требует вход: без токена и с невалидным — 401, портал не создаётся', async () => {
      for (const auth of [undefined, 'Bearer tok-bad']) {
        const { res, portalCalls } = await portal(auth, { action: 'portal' });
        assert.equal(res.statusCode, 401);
        assert.equal(portalCalls.length, 0);
      }
    });

    it('портал только для клиента этого uid; customerId, uid и email из тела игнорируются', async () => {
      const mine = await portal('Bearer tok-user', { action: 'portal', customerId: 'cust-user-2', uid: 'user-2', external_customer_id: 'user-2' });
      assert.equal(mine.res.statusCode, 200);
      assert.deepEqual(mine.res.body, { url: 'https://sandbox.polar.sh/portal/cust-user-1' });
      assert.deepEqual(mine.portalCalls, [{ customerId: 'cust-user-1', returnUrl: 'https://app.example.com/#exam' }]);
      assert.equal(mine.checkoutCalls.length, 0, 'портал не создаёт checkout');

      const theirs = await portal('Bearer tok-other', { action: 'portal', from: 'constitution' });
      assert.deepEqual(theirs.res.body, { url: 'https://sandbox.polar.sh/portal/cust-user-2' });
      assert.equal(theirs.portalCalls[0].returnUrl, 'https://app.example.com/#constitution');

      const fromSettings = await portal('Bearer tok-other', { action: 'portal', from: 'settings' });
      assert.equal(fromSettings.portalCalls[0].returnUrl, 'https://app.example.com/#settings');
    });

    it('нет покупок -> 404 NO_PURCHASES, чужой клиент не подставляется', async () => {
      const lookups: string[] = [];
      const { res, portalCalls } = await portal('Bearer tok-none', { action: 'portal' }, {
        findCustomerId: async (uid: string) => { lookups.push(uid); return ''; },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.code, 'NO_PURCHASES');
      assert.equal(portalCalls.length, 0);
      assert.deepEqual(lookups, ['user-3'], 'запасной поиск идёт только по uid из токена');
    });

    it('старые заказы без customerId: запасной поиск по uid из токена', async () => {
      const { res, portalCalls } = await portal('Bearer tok-none', { action: 'portal' }, {
        findCustomerId: async (uid: string) => (uid === 'user-3' ? 'cust-found' : ''),
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(portalCalls, [{ customerId: 'cust-found', returnUrl: 'https://app.example.com/#exam' }]);
    });

    it('хранилище недоступно -> 503/502, портал не создаётся; не настроено -> 503', async () => {
      const down = await portal('Bearer tok-user', { action: 'portal' }, { db: fakeDb({ fail: true }) });
      assert.equal(down.res.statusCode, 502);
      assert.equal(down.portalCalls.length, 0);
      const noDb = await portal('Bearer tok-user', { action: 'portal' }, { db: null });
      assert.equal(noDb.res.statusCode, 503);
      assert.equal(noDb.portalCalls.length, 0);
      const noEnv = await portal('Bearer tok-user', { action: 'portal' }, { env: { ...ENV, POLAR_ACCESS_TOKEN: '' } });
      assert.equal(noEnv.res.statusCode, 503);
      const failing = await portal('Bearer tok-user', { action: 'portal' }, { createPortal: async () => { throw new Error('polar down'); } });
      assert.equal(failing.res.statusCode, 502);
    });
  });
});

describe('billing observability & structured error logging', () => {
  describe('extractPolarStatus', () => {
    it('извлекает statusCode, status и response.status, отсекая невалидные значения', () => {
      assert.equal(billing.extractPolarStatus({ statusCode: 400 }), 400);
      assert.equal(billing.extractPolarStatus({ status: 502 }), 502);
      assert.equal(billing.extractPolarStatus({ response: { status: 429 } }), 429);
      assert.equal(billing.extractPolarStatus({ statusCode: '404' }), 404);
      assert.equal(billing.extractPolarStatus({ status: 99 }), undefined);
      assert.equal(billing.extractPolarStatus({ status: 600 }), undefined);
      assert.equal(billing.extractPolarStatus(new Error('fail')), undefined);
      assert.equal(billing.extractPolarStatus(null), undefined);
      assert.equal(billing.extractPolarStatus(undefined), undefined);
    });
  });

  describe('extractRequestId', () => {
    it('извлекает x-request-id, x-vercel-id или webhook-id из заголовков', () => {
      assert.equal(billing.extractRequestId({ headers: { 'x-request-id': 'req-123' } }), 'req-123');
      assert.equal(billing.extractRequestId({ headers: { 'x-vercel-id': 'iad1::abc' } }), 'iad1::abc');
      assert.equal(billing.extractRequestId({ headers: { 'webhook-id': 'msg-999' } }), 'msg-999');
      assert.equal(billing.extractRequestId({ headers: { 'x-request-id': ['req-arr-1'] } }), 'req-arr-1');
      assert.equal(billing.extractRequestId({ headers: { 'x-request-id': '   ' } }), undefined);
      assert.equal(billing.extractRequestId({ headers: {} }), undefined);
      assert.equal(billing.extractRequestId(null), undefined);
    });
  });

  describe('productKeyForId & scopes', () => {
    it('сопоставляет ID продуктов с ключами планов и строками прав', () => {
      assert.equal(billing.productKeyForId('prod-1m', ENV), 'exam_1m');
      assert.equal(billing.productKeyForId('prod-bundle', ENV), 'bundle_2m');
      assert.equal(billing.productKeyForId('prod-const', ENV), 'const_2m');
      assert.equal(billing.productKeyForId('prod-unknown', ENV), '');

      assert.equal(billing.scopeStringForPlan('exam_1m'), 'exam');
      assert.equal(billing.scopeStringForPlan('bundle_2m'), 'exam,constitution');
      assert.equal(billing.scopeStringForPlan('const_2m'), 'constitution');
      assert.equal(billing.scopeStringForPlan('unknown'), '');

      assert.equal(billing.scopeStringForProduct('prod-1m', ENV), 'exam');
      assert.equal(billing.scopeStringForProduct('prod-bundle', ENV), 'exam,constitution');
      assert.equal(billing.scopeStringForProduct('unknown', ENV), '');
    });
  });

  describe('logBillingCheckoutError', () => {
    it('логирует структурированную ошибку без PII и секретов', () => {
      const logs: string[] = [];
      const origError = console.error;
      console.error = (msg: unknown) => { logs.push(String(msg)); };
      try {
        const error = new Error('Polar 400 Bad Request');
        (error as unknown as { statusCode: number }).statusCode = 400;
        const entry = logBillingCheckoutError({
          error,
          req: { headers: { 'x-request-id': 'req-test-456' } },
          productKey: 'exam_1m',
          scope: 'exam',
        });

        assert.equal(entry.event, 'billing_checkout_error');
        assert.equal(entry.productKey, 'exam_1m');
        assert.equal(entry.scope, 'exam');
        assert.equal(entry.polarStatus, 400);
        assert.equal(entry.requestId, 'req-test-456');
        assert.equal(logs.length, 1);
        const parsed = JSON.parse(logs[0]);
        assert.equal(parsed.event, 'billing_checkout_error');
        assert.equal(parsed.polarStatus, 400);
        assert.equal('email' in parsed, false);
        assert.equal('token' in parsed, false);
      } finally {
        console.error = origError;
      }
    });

    it('checkout при 429 от Polar возвращает BILLING_RATE_LIMITED', async () => {
      const err = new Error('Too many requests');
      (err as unknown as { statusCode: number }).statusCode = 429;
      const res = mockRes();
      await handleBillingCheckout(
        { method: 'POST', headers: { authorization: 'Bearer tok-user', 'x-request-id': 'req-rate-limit' }, body: { plan: 'exam_1m' } },
        res,
        {
          env: ENV,
          createCheckout: async () => { throw err; },
        },
      );
      assert.equal(res.statusCode, 429);
      assert.equal((res.body as { code: string }).code, 'BILLING_RATE_LIMITED');
    });
  });

  describe('webhook error logging', () => {
    it('логирует структурированную запись при неверной подписи без утечки секрета', async () => {
      const logs: string[] = [];
      const origError = console.error;
      console.error = (msg: unknown) => { logs.push(String(msg)); };
      try {
        const res = mockRes();
        const headers = { ...sign('{"type":"order.paid"}', { secret: 'wrong_secret' }), 'webhook-id': 'msg-bad-sig' };
        await handleBillingWebhook({ method: 'POST', headers, rawBody: '{"type":"order.paid"}' }, res, { env: ENV });
        assert.equal(res.statusCode, 403);
        assert.equal(logs.length > 0, true);
        const errorLog = logs.find(l => l.includes('invalid_signature'));
        assert.ok(errorLog, 'должен быть лог с invalid_signature');
        const parsed = JSON.parse(errorLog);
        assert.equal(parsed.requestId, 'msg-bad-sig');
        assert.equal(parsed.outcome, 'invalid_signature');
        assert.equal(errorLog.includes(SECRET), false, 'секрет не должен утекать в логи');
      } finally {
        console.error = origError;
      }
    });
  });
});
