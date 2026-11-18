// Платный доступ через Polar (merchant of record): два независимых права, exam и constitution.
// Разовые покупки без автопродления. ID продуктов, токен и секрет вебхука берутся только из окружения сервера.
//
// Firestore (пишет только Admin SDK, клиенту правила закрывают и чтение, и запись):
//   examAccess/{uid}        = { examPaidUntil, constitutionPaidUntil, customerId?,
//                               grants: [{ orderId, productId, scopes: { exam?: months, constitution?: months }, paidAt, refundedAt? }],
//                               updatedAt }
//   billingOrders/{orderId} = { uid, productId, scopes, months, customerId?, status: 'paid'|'refunded', paidAt?, refundedAt? }
// Старый grant { months } без scopes читается как { exam: months }; сохранённые документы не мигрируют.
// Обе даты *PaidUntil всегда пересчитываются из grants (см. untilsFromGrants) — отдельно по каждому праву,
// поэтому возврат убирает ровно свою покупку, а повтор события ничего не меняет.

const EXAM_ACCESS_COLLECTION = 'examAccess';
const BILLING_ORDERS_COLLECTION = 'billingOrders';

const SCOPES = Object.freeze(['exam', 'constitution']);
const ACCESS_TIME_ZONE = 'Europe/Vilnius';

/**
 * Продукты Polar. purchasable: false — только для вебхука и возвратов (checkout такой план не создаёт).
 * Цен здесь нет: они живут в Polar.
 */
const PRODUCTS = Object.freeze({
  exam_1m: Object.freeze({ productEnv: 'POLAR_PRODUCT_EXAM_1M', scopes: Object.freeze({ exam: 1 }), purchasable: true }),
  exam_2m: Object.freeze({ productEnv: 'POLAR_PRODUCT_EXAM_2M', scopes: Object.freeze({ exam: 2 }), purchasable: true }),
  bundle_2m: Object.freeze({ productEnv: 'POLAR_PRODUCT_BUNDLE_2M', scopes: Object.freeze({ exam: 2, constitution: 2 }), purchasable: true }),
  const_2m: Object.freeze({ productEnv: 'POLAR_PRODUCT_CONST_2M', scopes: Object.freeze({ constitution: 2 }), purchasable: true }),
  // LEGACY: купленные ранее 3 месяца. Вебхук и возвраты их знают, checkout — нет.
  exam_3m: Object.freeze({ productEnv: 'POLAR_PRODUCT_EXAM_3M', scopes: Object.freeze({ exam: 3 }), purchasable: false }),
});

/** Старые клиенты присылали '1m'. '3m' больше не продаётся. */
const LEGACY_PLAN_ALIASES = Object.freeze({ '1m': 'exam_1m' });

/** Сколько ждать транзакцию Firestore в вебхуке. Polar повторит доставку при 5xx. */
const BILLING_STORE_TIMEOUT_MS = 8000;

function envString(env, name) {
  const value = env && typeof env[name] === 'string' ? env[name].trim() : '';
  return value;
}

/** Ключ продаваемого плана или '' (неизвестный, legacy exam_3m, не строка). */
function resolvePlan(value) {
  if (typeof value !== 'string') return '';
  const key = Object.prototype.hasOwnProperty.call(LEGACY_PLAN_ALIASES, value) ? LEGACY_PLAN_ALIASES[value] : value;
  if (!Object.prototype.hasOwnProperty.call(PRODUCTS, key)) return '';
  return PRODUCTS[key].purchasable ? key : '';
}

function isPlan(value) {
  return resolvePlan(value) !== '';
}

/** ID продукта Polar для продаваемого плана или '' — если переменная окружения не задана. */
function productIdForPlan(plan, env = process.env) {
  const key = resolvePlan(plan);
  return key ? envString(env, PRODUCTS[key].productEnv) : '';
}

/** Что даёт продукт: { exam?: months, constitution?: months }. {} — продукт не наш (или окружение не настроено). */
function scopesForProduct(productId, env = process.env) {
  if (typeof productId !== 'string' || !productId) return {};
  for (const product of Object.values(PRODUCTS)) {
    if (envString(env, product.productEnv) === productId) return { ...product.scopes };
  }
  return {};
}

/** 'sandbox' | 'production' или null: без явного значения в Polar не ходим. */
function polarServer(env = process.env) {
  const value = envString(env, 'POLAR_SERVER').toLowerCase();
  return value === 'sandbox' || value === 'production' ? value : null;
}

/**
 * Календарные месяцы в UTC. Число месяца, которого нет в целевом месяце, прижимается к последнему дню:
 * 31 января + 1 месяц = 28 (29) февраля, а не 3 марта.
 */
function addMonthsUTC(ms, months) {
  const date = new Date(ms);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

const zoneFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ACCESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zoneFields(ms) {
  const fields = {};
  for (const part of zoneFormatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return fields;
}

/** Календарная дата момента ms в Europe/Vilnius: { year, month (0-11), day }. */
function vilniusDate(ms) {
  const f = zoneFields(ms);
  return { year: f.year, month: f.month - 1, day: f.day };
}

/** Смещение Europe/Vilnius от UTC в мс на момент ms (+2 ч зимой, +3 ч летом). */
function zoneOffsetMs(ms) {
  const f = zoneFields(ms);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Последняя миллисекунда (23:59:59.999) календарного дня в Europe/Vilnius.
 * Полночь по Вильнюсу не попадает на переход на летнее время (он в 03:00/04:00), поэтому двух итераций хватает.
 */
function endOfDayVilnius(year, month, day) {
  const nextMidnightAsUtc = Date.UTC(year, month, day + 1);
  let instant = nextMidnightAsUtc - zoneOffsetMs(nextMidnightAsUtc);
  instant = nextMidnightAsUtc - zoneOffsetMs(instant);
  return instant - 1;
}

/**
 * Конец периода: якорная дата (по Вильнюсу) + суммарные месяцы одним прыжком, чтобы цепочка продлений не «дрейфовала»
 * (31 янв +1 мес +1 мес = 31 марта, а не 28 марта). Включительно до конца этого дня по Вильнюсу.
 */
function untilForPeriod(anchorMs, totalMonths) {
  const { year, month, day } = vilniusDate(anchorMs);
  const shifted = new Date(addMonthsUTC(Date.UTC(year, month, day, 12), totalMonths));
  return endOfDayVilnius(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function validMonths(value) {
  return Number.isInteger(value) && value > 0;
}

/** Права grant'а: { exam?, constitution? }. Старый { months } без scopes = { exam: months }. */
function grantScopes(grant) {
  if (!grant || typeof grant !== 'object') return {};
  const out = {};
  if (grant.scopes && typeof grant.scopes === 'object') {
    for (const scope of SCOPES) {
      if (validMonths(grant.scopes[scope])) out[scope] = grant.scopes[scope];
    }
    return out;
  }
  if (validMonths(grant.months)) out.exam = grant.months;
  return out;
}

function validGrant(grant) {
  return !!grant
    && typeof grant === 'object'
    && typeof grant.orderId === 'string'
    && Number.isFinite(grant.paidAt)
    && Object.keys(grantScopes(grant)).length > 0;
}

/**
 * Период права из журнала: возвращённые пропускаются, остальные идут по порядку оплаты.
 * Оплата до конца действующего срока продолжает период (месяцы суммируются от прежнего якоря),
 * оплата после истечения начинает новый период с даты оплаты.
 * Возвращает { until, anchor, months }; until === 0, если доступа нет.
 */
function periodFromGrants(grants, scope) {
  const list = (Array.isArray(grants) ? grants : [])
    .filter((grant) => validGrant(grant) && !grant.refundedAt && grantScopes(grant)[scope] > 0)
    .sort((a, b) => a.paidAt - b.paidAt || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
  let anchor = 0;
  let months = 0;
  let until = 0;
  for (const grant of list) {
    const add = grantScopes(grant)[scope];
    if (until > 0 && grant.paidAt <= until) {
      months += add;
    } else {
      anchor = grant.paidAt;
      months = add;
    }
    until = untilForPeriod(anchor, months);
  }
  return { until, anchor, months };
}

/** Срок одного права из журнала (0 — нет доступа). */
function paidUntilFromGrants(grants, scope = 'exam') {
  return periodFromGrants(grants, scope).until;
}

/** { exam, constitution } — обе даты из журнала, независимо. */
function untilsFromGrants(grants) {
  return { exam: paidUntilFromGrants(grants, 'exam'), constitution: paidUntilFromGrants(grants, 'constitution') };
}

/**
 * Какой станет дата окончания права после покупки на months месяцев прямо сейчас (для превью «до 14.03 → станет 14.05»).
 * Считается тем же алгоритмом, что и вебхук, поэтому совпадает с итогом оплаты.
 */
function previewUntil(grants, scope, months, now) {
  const virtual = { orderId: '\uffffpreview', scopes: { [scope]: months }, paidAt: now };
  return paidUntilFromGrants([...(Array.isArray(grants) ? grants : []), virtual], scope);
}

/** Срок права из документа examAccess (examPaidUntil / constitutionPaidUntil) или 0. */
function paidUntilFrom(data, scope = 'exam') {
  const value = data && typeof data === 'object' ? data[`${scope}PaidUntil`] : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** uid из metadata заказа: его кладёт только наш сервер при создании checkout. */
function uidFromMetadata(metadata) {
  const uid = metadata && typeof metadata === 'object' ? metadata.uid : undefined;
  if (typeof uid !== 'string') return '';
  const trimmed = uid.trim();
  if (!trimmed || trimmed.length > 128 || trimmed.includes('/')) return '';
  return trimmed;
}

/** ID клиента Polar из заказа (order.customer_id или order.customer.id) или ''. */
function customerIdFromOrder(order) {
  const direct = typeof order?.customer_id === 'string' ? order.customer_id : '';
  const nested = typeof order?.customer?.id === 'string' ? order.customer.id : '';
  const id = (direct || nested).trim();
  return id && id.length <= 128 && !id.includes('/') ? id : '';
}

function accessRefs(db, uid, orderId) {
  return {
    accessRef: db.collection(EXAM_ACCESS_COLLECTION).doc(uid),
    orderRef: db.collection(BILLING_ORDERS_COLLECTION).doc(orderId),
  };
}

function grantsOf(snap) {
  const data = snap && snap.exists ? snap.data() : null;
  return Array.isArray(data?.grants) ? data.grants.filter(validGrant) : [];
}

function storedCustomerId(snap) {
  const data = snap && snap.exists ? snap.data() : null;
  return typeof data?.customerId === 'string' ? data.customerId : '';
}

/** Документ examAccess: обе даты из журнала; customerId сохраняется, если уже известен. */
function accessDocument(grants, customerId, now) {
  const untils = untilsFromGrants(grants);
  const doc = { examPaidUntil: untils.exam, constitutionPaidUntil: untils.constitution, grants, updatedAt: now };
  if (customerId) doc.customerId = customerId;
  return { doc, untils };
}

/**
 * order.paid: продлевает права один раз на заказ.
 * Возвращает { outcome: 'granted', paidUntil, constitutionPaidUntil } или { outcome: 'duplicate' } (заказ уже обработан или уже возвращён).
 * Если ранее пришёл ранний частичный возврат (status === 'partially_refunded' без paidAt),
 * права открываются, а запись о частичном возврате сохраняется в журнале.
 */
async function applyPaidOrder(db, { orderId, uid, productId, scopes, customerId = '', now = Date.now() }) {
  const { accessRef, orderRef } = accessRefs(db, uid, orderId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const accessSnap = await tx.get(accessRef);
    if (orderSnap.exists) {
      const existing = orderSnap.data();
      // Если заказ уже оплачен или полностью возвращён — дубликат
      if (existing?.status === 'refunded' || existing?.status === 'paid' || existing?.paidAt) {
        return { outcome: 'duplicate' };
      }
      // Если был ранний частичный возврат (status === 'partially_refunded' до order.paid):
      if (existing?.status === 'partially_refunded') {
        const grants = grantsOf(accessSnap);
        const grant = { orderId, productId, scopes: { ...scopes }, paidAt: now };
        if (scopes.exam) grant.months = scopes.exam;
        grants.push(grant);
        const { doc, untils } = accessDocument(grants, customerId || storedCustomerId(accessSnap), now);
        const months = Math.max(...Object.values(scopes));
        const order = {
          ...existing,
          uid: uid || existing.uid,
          productId,
          scopes: { ...scopes },
          months,
          status: 'partially_refunded',
          paidAt: now,
        };
        if (customerId) order.customerId = customerId;
        tx.set(accessRef, doc);
        tx.set(orderRef, order);
        return { outcome: 'granted', paidUntil: untils.exam, constitutionPaidUntil: untils.constitution };
      }
      return { outcome: 'duplicate' };
    }
    const grants = grantsOf(accessSnap);
    const grant = { orderId, productId, scopes: { ...scopes }, paidAt: now };
    // Откат: старый код читает только `months` как экзамен. Пишем его лишь когда есть scope exam,
    // иначе Constitution-only grant дал бы старому коду доступ к экзамену.
    if (scopes.exam) grant.months = scopes.exam;
    grants.push(grant);
    const { doc, untils } = accessDocument(grants, customerId || storedCustomerId(accessSnap), now);
    const months = Math.max(...Object.values(scopes));
    const order = { uid, productId, scopes: { ...scopes }, months, status: 'paid', paidAt: now };
    if (customerId) order.customerId = customerId;
    tx.set(accessRef, doc);
    tx.set(orderRef, order);
    return { outcome: 'granted', paidUntil: untils.exam, constitutionPaidUntil: untils.constitution };
  });
}

/**
 * order.refunded (полный возврат): убирает покупку из журнала и пересчитывает оба срока.
 * Возврат раньше оплаты (события пришли не по порядку) запоминается, и поздний order.paid уже ничего не даст.
 */
async function applyRefundedOrder(db, { orderId, uid: uidHint = '', now = Date.now() }) {
  const orderRef = db.collection(BILLING_ORDERS_COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const order = orderSnap.exists ? orderSnap.data() : null;
    if (order && order.status === 'refunded') return { outcome: 'duplicate' };
    if (!order) {
      tx.set(orderRef, { uid: uidHint, status: 'refunded', refundedAt: now });
      return { outcome: 'refund_before_paid' };
    }
    // Если заказ был частично возвращён до оплаты, но так и не оплачен (order.paidAt нет):
    if (!order.paidAt) {
      tx.set(orderRef, { ...order, status: 'refunded', refundedAt: now });
      return { outcome: 'refund_before_paid' };
    }
    const uid = typeof order.uid === 'string' && order.uid ? order.uid : uidHint;
    if (!uid) {
      tx.set(orderRef, { ...order, status: 'refunded', refundedAt: now });
      return { outcome: 'refunded_no_uid' };
    }
    const accessRef = db.collection(EXAM_ACCESS_COLLECTION).doc(uid);
    const accessSnap = await tx.get(accessRef);
    const grants = grantsOf(accessSnap).map((grant) => (
      grant.orderId === orderId && !grant.refundedAt ? { ...grant, refundedAt: now } : grant
    ));
    const { doc, untils } = accessDocument(grants, storedCustomerId(accessSnap), now);
    tx.set(accessRef, doc);
    tx.set(orderRef, { ...order, status: 'refunded', refundedAt: now });
    return { outcome: 'revoked', paidUntil: untils.exam, constitutionPaidUntil: untils.constitution };
  });
}

/**
 * order.refunded / order.updated (частичный возврат):
 * доступ НЕ отзывает, записывает в журнал billingOrders/{orderId}:
 * { status: 'partially_refunded', refundedAmount, partiallyRefundedAt }.
 * Если возврат пришёл раньше оплаты — запоминает в журнале, и поздний order.paid
 * откроет доступ, сохранив отметку о частичном возврате.
 */
async function applyPartialRefundOrder(db, { orderId, uid: uidHint = '', refundedAmount = 0, now = Date.now() }) {
  const orderRef = db.collection(BILLING_ORDERS_COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const order = orderSnap.exists ? orderSnap.data() : null;
    // Полный возврат главнее: если заказ уже полностью возвращён, частичный возврат игнорируется
    if (order && order.status === 'refunded') {
      return { outcome: 'duplicate' };
    }
    // Повтор частичного возврата с той же суммой
    if (order && order.status === 'partially_refunded' && order.refundedAmount === refundedAmount) {
      return { outcome: 'duplicate' };
    }
    // Ранний частичный возврат до order.paid
    if (!order || !order.paidAt) {
      const base = order || {};
      const earlyOrder = {
        ...base,
        uid: uidHint || base.uid || '',
        status: 'partially_refunded',
        refundedAmount,
        partiallyRefundedAt: base.partiallyRefundedAt || now,
      };
      tx.set(orderRef, earlyOrder);
      return { outcome: 'partial_refund_before_paid' };
    }
    const updatedOrder = {
      ...order,
      status: 'partially_refunded',
      refundedAmount,
      partiallyRefundedAt: order.partiallyRefundedAt || now,
    };
    if (uidHint && !updatedOrder.uid) {
      updatedOrder.uid = uidHint;
    }
    tx.set(orderRef, updatedOrder);
    return { outcome: 'partial_refund_kept' };
  });
}

/** Полный возврат: статус refunded или вернули всю сумму. */
function isFullRefund(order) {
  if (!order || typeof order !== 'object') return false;
  if (order.status === 'refunded') return true;
  const total = Number(order.total_amount !== undefined ? order.total_amount : order.totalAmount);
  const refunded = Number(order.refunded_amount !== undefined ? order.refunded_amount : order.refundedAmount);
  return Number.isFinite(total) && total > 0 && Number.isFinite(refunded) && refunded >= total;
}

/** Сумма возврата из заказа Polar или 0. */
function refundedAmountFromOrder(order) {
  if (!order || typeof order !== 'object') return 0;
  const raw = order.refunded_amount !== undefined ? order.refunded_amount : order.refundedAmount;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/** Частичный возврат: статус partially_refunded или сумма возврата больше 0, но меньше полной суммы. */
function isPartialRefund(order) {
  if (!order || typeof order !== 'object') return false;
  if (isFullRefund(order)) return false;
  if (order.status === 'partially_refunded') return true;
  return refundedAmountFromOrder(order) > 0;
}

/** Адрес приложения для возврата из checkout: APP_URL, иначе production-домен Vercel. Только http(s). */
function appBaseUrl(env = process.env) {
  const candidates = [envString(env, 'APP_URL')];
  const vercelHost = envString(env, 'VERCEL_PROJECT_PRODUCTION_URL');
  if (vercelHost) candidates.push(`https://${vercelHost}`);
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      return url.origin;
    } catch {
      // не URL — пробуем следующий источник
    }
  }
  return '';
}

function polarClient(env) {
  const { createPolar } = require('@polar-sh/sdk/2026-10');
  return createPolar({
    accessToken: envString(env, 'POLAR_ACCESS_TOKEN'),
    environment: polarServer(env),
    timeout: 15,
  });
}

/** Checkout в Polar через официальный SDK. Возвращает адрес страницы оплаты. */
async function createPolarCheckout({ productId, uid, email, successUrl, returnUrl }, env = process.env) {
  const polar = polarClient(env);
  const body = {
    products: [productId],
    metadata: { uid },
    success_url: successUrl,
    return_url: returnUrl,
  };
  if (email) body.customer_email = email;
  const checkout = await polar.checkouts.create(body);
  return typeof checkout?.url === 'string' ? checkout.url : '';
}

/** Клиент Polar для uid из нашего хранилища: customerId пишет только вебхук в examAccess/{uid}. '' — покупок не было. */
async function storedPortalCustomerId(db, uid) {
  const snap = await db.collection(EXAM_ACCESS_COLLECTION).doc(uid).get();
  return storedCustomerId(snap);
}

/**
 * Запасной поиск для заказов до появления customerId в хранилище: заказы Polar с нашим metadata.uid.
 * Фильтр Polar не считается доверенным: берём только заказ, у которого metadata.uid точно равен uid.
 */
async function polarCustomerIdByUid(uid, env = process.env) {
  const polar = polarClient(env);
  const page = await polar.orders.list({ metadata: { uid }, limit: 20 });
  const items = Array.isArray(page?.items) ? page.items : [];
  for (const order of items) {
    if (uidFromMetadata(order?.metadata) !== uid) continue;
    if (order?.status === 'refunded' || order?.status === 'void' || order?.status === 'draft' || order?.status === 'pending') continue;
    const id = customerIdFromOrder(order);
    if (id) return id;
  }
  return '';
}

/** Сессия клиентского портала Polar (история покупок и чеки). Возвращает адрес портала. */
async function createPolarPortalSession({ customerId, returnUrl }, env = process.env) {
  const polar = polarClient(env);
  const body = { customer_id: customerId };
  if (returnUrl) body.return_url = returnUrl;
  const session = await polar.customerSessions.create(body);
  return typeof session?.customer_portal_url === 'string' ? session.customer_portal_url : '';
}

/** Находит ключ продукта (например, 'exam_1m') по ID продукта Polar в окружении. */
function productKeyForId(productId, env = process.env) {
  if (typeof productId !== 'string' || !productId) return '';
  for (const [key, product] of Object.entries(PRODUCTS)) {
    if (envString(env, product.productEnv) === productId) return key;
  }
  return '';
}

/** Строка прав плана (например, 'exam', 'constitution' или 'exam,constitution'). */
function scopeStringForPlan(plan) {
  const key = resolvePlan(plan);
  if (!key || !PRODUCTS[key]) return '';
  return Object.keys(PRODUCTS[key].scopes).join(',');
}

/** Строка прав по ID продукта Polar в окружении. */
function scopeStringForProduct(productId, env = process.env) {
  const scopes = scopesForProduct(productId, env);
  const keys = Object.keys(scopes);
  return keys.length > 0 ? keys.join(',') : '';
}

/** HTTP-статус из ошибки Polar API (statusCode или status), если это валидный код. */
function extractPolarStatus(error) {
  if (!error || typeof error !== 'object') return undefined;
  const raw = error.statusCode ?? error.status ?? error.response?.status;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 100 && num < 600 ? num : undefined;
}

/** Идентификатор запроса из заголовков (x-request-id, x-vercel-id или webhook-id) без PII. */
function extractRequestId(req) {
  if (!req || typeof req !== 'object') return undefined;
  const headers = req.headers || {};
  const val = headers['x-request-id'] || headers['x-vercel-id'] || headers['webhook-id'];
  const first = Array.isArray(val) ? val[0] : val;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

module.exports = {
  EXAM_ACCESS_COLLECTION,
  BILLING_ORDERS_COLLECTION,
  BILLING_STORE_TIMEOUT_MS,
  SCOPES,
  ACCESS_TIME_ZONE,
  PRODUCTS,
  resolvePlan,
  isPlan,
  productIdForPlan,
  scopesForProduct,
  productKeyForId,
  scopeStringForPlan,
  scopeStringForProduct,
  extractPolarStatus,
  extractRequestId,
  polarServer,
  addMonthsUTC,
  vilniusDate,
  endOfDayVilnius,
  untilForPeriod,
  grantScopes,
  periodFromGrants,
  paidUntilFromGrants,
  untilsFromGrants,
  previewUntil,
  paidUntilFrom,
  uidFromMetadata,
  customerIdFromOrder,
  applyPaidOrder,
  applyRefundedOrder,
  applyPartialRefundOrder,
  isFullRefund,
  isPartialRefund,
  refundedAmountFromOrder,
  appBaseUrl,
  createPolarCheckout,
  storedPortalCustomerId,
  polarCustomerIdByUid,
  createPolarPortalSession,
};
