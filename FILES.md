# Files in this showcase

Representative source files copied from the private app repository. They do not include paid exam or Constitution content. The Firebase web API key in `code/api/_security.js` is replaced with a placeholder.

## Billing, access, and security

- `code/api/_billing.js` — Polar webhook and checkout helpers: independent exam and Constitution entitlements, idempotent grant replay, refund handling, and Vilnius timezone paid-until dates. Product IDs and secrets come from server environment variables.
- `code/api/_billing.test.ts` — Tests for those helpers, webhook HMAC verification, checkout plan resolution, and independent exam/Constitution access after refunds.
- `code/api/_security.js` — Firebase ID-token checks for AI and billing endpoints, App Check integration, a pre-auth IP limiter, and per-endpoint guest versus signed-in quotas.
- `code/firestore.rules` — Clients may read or write only their own `users/{uid}` document (with type checks and a ban on `geminiKey`); `examAccess` and `billingOrders` are server-written, read only by the owner.
- `code/src/data/lt/constitution/constitutionAccess.ts` — Server-only payload helpers that mark chapters 1–2 as free and chapters 3–15 plus mock-exam variants as paid; the file contains no chapter or question text.
- `code/src/data/lt/exam/interviewAccess.ts` — Builds the interview-trainer payload: the first 12 questions are free, later questions and all answer templates require paid access. Question text is imported, not inlined.
- `code/src/exam/useAccessStatus.ts` — React hook that loads exam/Constitution access, handles the return from Polar (`#settings`, `#exam`, `#constitution`), and polls for up to 10 tries after checkout.

## Content-protection tests

- `code/src/data/lt/constitution/constitutionProtection.test.ts` — Checks that client code never imports the constitution index, paid chapters, or paid questions, and that outline/metadata stay in sync with the data files.
- `code/src/data/lt/constitution/constitutionDistLeak.test.ts` — Builds the Vite client bundle and asserts that distinctive phrases from paid chapters 3–15 and mock-exam questions are absent from `dist`.

## Exam grading (NŠA)

- `code/src/exam/core/scoring.ts` — Scores reading/writing, listening, and speaking parts against an exam spec, including Lithuanian-aware answer normalisation, speaking thresholds, and the final A2 / A1 / fail verdict.
- `code/src/exam/result/gradeCalculator.ts` — Applies official category-1 score ranges to user-entered part scores and returns the per-part levels plus the overall result.

## App shell and tooling

- `code/src/components/ErrorBoundary.tsx` — Class error boundary that shows a translated fallback with a retry action when a view fails to render.
- `code/.github/workflows/ci.yml` — GitHub Actions CI on pull requests and `main`: npm audit, TypeScript, unit tests, production build, a first-load JS budget check, and Playwright end-to-end tests.
- `code/vite.config.ts` — Vite + React + Tailwind + PWA setup: copies security headers from `vercel.json` onto the local preview, and splits heavy Lithuanian course modules into manual chunks.
- `code/vercel.json` — Vercel config: `fra1` region, SPA rewrites to `index.html`, 30-second API functions, and security headers including HSTS, frame denial, and a Content-Security-Policy.
