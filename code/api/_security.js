// Общая защита AI-эндпоинтов: идентификация по Firebase ID-токену + лимиты запросов.
// Токен проверяется через публичный Identity Toolkit REST (firebase-admin не нужен).

const { IDENTITY_LOOKUP_TIMEOUT_MS, ERROR_CODES, MESSAGES } = require('./_limits');
const { clientIp, createWindowLimiter } = require('./_rateLimit');
const { usageSubject } = require('./_usage');
const {
  GUARDED_ENDPOINTS,
  FAIL_OPEN_REASONS,
  appCheckMode,
  appCheckToken,
  verifyAppCheckToken,
  logAppCheck,
} = require('./_appCheck');

const WEB_API_KEY = '<FIREBASE_WEB_API_KEY>'; // публичный ключ веб-приложения Firebase

// Гостям — жёсткий лимит по IP, вошедшим — щедрый по аккаунту. Окно — 1 час.
// TTS не тратит квоту Gemini и самый частотный (каждое нажатие 🔊) — лимит выше,
// но лимит для гостей намеренно сделан строже, чтобы один IP не мог сжечь большой объём апстрим-трафика озвучки.
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT_GUEST = 30;
const LIMIT_USER = 300;
const LIMITS_BY_ENDPOINT = {
  tts: { guest: 60, user: 1000 },
  ask: { guest: 15, user: 60 },
  speak: { guest: 15, user: 120 },
  chat: { guest: 30, user: 120 },
  mentor: { guest: 30, user: 60 },
  admin: { guest: 20, user: 120 },
  billing: { guest: 10, user: 30 },
};

// Дешёвый лимит по IP ДО проверки токена: флуд без токена не доходит ни до Identity Toolkit, ни до Firestore.
// Окно короткое и щедрое (общий Wi-Fi/NAT), на реальных пользователей не влияет.
const PRE_AUTH_WINDOW_MS = 60 * 1000;
const PRE_AUTH_LIMIT = 60;
const PRE_AUTH_LIMITS_BY_ENDPOINT = {
  tts: 30,
  billing: 20,
  // Вебхуки Polar приходят пачками с нескольких адресов; отказ = повторная доставка, поэтому лимит щедрый.
  billingWebhook: 600,
};

// Памяти процесса хватает как первой линии: у каждого инстанса свой счётчик,
// холодный старт сбрасывает бакет — против бот-спама этого достаточно.
// Размер карт ограничен (см. createWindowLimiter), неограниченно расти они не могут.
const hourly = createWindowLimiter({ windowMs: WINDOW_MS });
const preAuth = createWindowLimiter({ windowMs: PRE_AUTH_WINDOW_MS });

/** true, если IP укладывается в короткий лимит. Вызывается до getIdentity. */
function checkPreAuthRate(req, endpoint) {
  const limit = PRE_AUTH_LIMITS_BY_ENDPOINT[endpoint] ?? PRE_AUTH_LIMIT;
  const ip = clientIp(req);
  // IP определить не удалось: один общий бакет 'unknown' заблокировал бы всех, поэтому не лимитируем.
  if (ip === 'unknown') return true;
  return preAuth.hit('ip:' + ip + ':' + endpoint, limit);
}

/**
 * Лимит за час. Вошедший считается по ключу аккаунта (хэш проверенной почты, иначе uid),
 * а не по uid: удаление аккаунта не сбрасывает окно. Гость — по IP.
 */
function checkRate(req, identity, endpoint) {
  const subject = identity ? usageSubject(identity, identity.uid) : null;
  const key = (subject ? 'u:' + subject : 'ip:' + clientIp(req)) + ':' + endpoint;
  const limits = LIMITS_BY_ENDPOINT[endpoint] || {};
  const limit = subject ? (limits.user ?? LIMIT_USER) : (limits.guest ?? LIMIT_GUEST);
  return hourly.hit(key, limit);
}

// Кэш проверки ID-токенов: экономит вызов Identity Toolkit на каждое сообщение.
// Токен Firebase живёт ~час, кэшируем на 10 минут. Кэшируется вся запись (uid, почта, флаги),
// а не только uid: по ней сервер решает, кому тратить серверный ключ Gemini.
const UID_CACHE_TTL = 10 * 60 * 1000;
const identityCache = new Map(); // token -> { identity, cachedAt }

/** Почта в едином виде: без пробелов по краям, нижний регистр. Не строка — пустая строка. */
function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Custom claims лежат в users[0].customAttributes как JSON-строка. Битый JSON — пустые claims. */
function claimsFrom(user) {
  if (typeof user?.customAttributes !== 'string') return {};
  try {
    const parsed = JSON.parse(user.customAttributes);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Запись пользователя из ответа accounts:lookup. Только то, что проверил Google. */
function identityFromLookup(user) {
  const uid = typeof user?.localId === 'string' ? user.localId : '';
  if (!uid) return null;
  const claims = claimsFrom(user);
  return {
    uid,
    email: normalizeEmail(user.email),
    emailVerified: user.emailVerified === true,
    adminClaim: claims.admin === true,
    examAdminClaim: claims.examAdmin === true,
  };
}

/** Извлекает Bearer-токен из заголовка Authorization или пустую строку. */
function bearerToken(req) {
  const header = req?.headers?.['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

/** Запрос к Identity Toolkit accounts:lookup по ID-токену. Возвращает users[0] или null. */
async function lookupIdToken(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout(IDENTITY_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.users?.[0] || null;
  } catch {
    return null;
  }
}

/** true для /api/admin/* — админские операции обходят кэш ID-токенов. */
function isAdminRoute(req) {
  const raw = typeof req?.url === 'string' ? req.url : '';
  if (!raw) return false;
  try {
    const pathname = new URL(raw, 'http://localhost').pathname;
    return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
  } catch {
    return raw.startsWith('/api/admin');
  }
}

/**
 * Проверенная личность по Bearer-токену: { uid, email, emailVerified, adminClaim, examAdminClaim } или null для гостя.
 * Почту и uid из тела запроса никогда не берём. Запросы к /api/admin/* (или opts.skipCache) не читают кэш.
 */
async function getIdentity(req, opts = {}) {
  const idToken = bearerToken(req);
  if (!idToken) return null;

  const bypassCache = opts?.skipCache === true || isAdminRoute(req);
  if (!bypassCache) {
    const cached = identityCache.get(idToken);
    if (cached && Date.now() - cached.cachedAt < UID_CACHE_TTL) return cached.identity;
  }

  const lookup = typeof opts?.lookup === 'function' ? opts.lookup : lookupIdToken;
  const user = await lookup(idToken);
  const identity = identityFromLookup(user);
  if (identity) {
    if (identityCache.size > 500) identityCache.clear();
    identityCache.set(idToken, { identity, cachedAt: Date.now() });
  } else if (bypassCache) {
    identityCache.delete(idToken);
  }
  return identity;
}

/** UID вошедшего пользователя по Bearer-токену или null для гостя. */
async function getUserUid(req) {
  return (await getIdentity(req))?.uid ?? null;
}

function resetIdentityCacheForTests() {
  identityCache.clear();
}

/**
 * App Check по режиму APP_CHECK_MODE (см. _appCheck.js). Возвращает причину отказа или null.
 * off — заголовок не читается вовсе; log — проверяем и пишем только неудачи, запрос проходит;
 * enforce — без валидного токена ответ 401 в общем формате { error, code } уже отправлен.
 * Место — после дешёвого лимита по IP и до Identity Toolkit: невалидный токен не тратит ни его, ни Firestore.
 */
async function checkAppCheck(req, res, endpoint) {
  const mode = appCheckMode();
  if (mode === 'off' || !GUARDED_ENDPOINTS.has(endpoint)) return null;
  const verdict = await verifyAppCheckToken(appCheckToken(req));
  if (verdict.ok) return null;
  logAppCheck({ endpoint, mode, reason: verdict.reason });
  // enforce — единственный режим, который отвечает. Ключи Google недоступны — пропускаем (см. FAIL_OPEN_REASONS).
  if (mode !== 'enforce' || FAIL_OPEN_REASONS.has(verdict.reason)) return null;
  res.status(401).json({ error: MESSAGES.appCheck, code: ERROR_CODES.appCheckFailed });
  return verdict.reason;
}

/**
 * То же, что guard, но отдаёт проверенные uid и identity (null для гостя): учёт по аккаунту и доступ к серверному ключу.
 * blocked: true — ответ 429/401 уже отправлен.
 */
async function guardUser(req, res, endpoint) {
  if (!checkPreAuthRate(req, endpoint)) {
    res.status(429).json({ error: 'Слишком много запросов. Попробуйте чуть позже.', code: ERROR_CODES.rateLimited });
    return { blocked: true, uid: null, identity: null };
  }
  if (await checkAppCheck(req, res, endpoint)) {
    return { blocked: true, uid: null, identity: null };
  }
  const identity = await getIdentity(req, { skipCache: endpoint === 'admin' });
  const uid = identity ? identity.uid : null;
  if (!checkRate(req, identity, endpoint)) {
    res.status(429).json({ error: 'Слишком много запросов. Войдите в аккаунт для большего лимита или попробуйте позже.', code: ERROR_CODES.rateLimited });
    return { blocked: true, uid, identity };
  }
  return { blocked: false, uid, identity };
}

/**
 * Единый вход для защищённых эндпоинтов. Возвращает null, если доступ разрешён,
 * либо готовый ответ res (429), который нужно вернуть вызывающему.
 */
async function guard(req, res, endpoint) {
  const { blocked } = await guardUser(req, res, endpoint);
  return blocked ? res : null;
}

module.exports = {
  clientIp,
  checkPreAuthRate,
  checkAppCheck,
  guard,
  guardUser,
  getIdentity,
  getUserUid,
  normalizeEmail,
  claimsFrom,
  bearerToken,
  lookupIdToken,
  identityFromLookup,
  resetIdentityCacheForTests,
};
