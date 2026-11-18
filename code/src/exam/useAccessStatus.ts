import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { authHeaders } from '../utils/firebase';
import { isBillingReturn, readBaseline, withoutBillingReturn, type ReturnSection } from './billing';
import { accessSignature, fetchAccessStatus, NO_ACCESS, type AccessStatus } from './examAccess';

export const PAYMENT_POLL_TRIES = 10;
export const PAYMENT_POLL_MS = 3000;

export type AccessView = {
  access: AccessStatus;
  state: 'loading' | 'ready' | 'error' | 'guest';
  /** Вернулись с оплаты и ждём вебхук (доступ ещё не обновился). */
  awaiting: boolean;
  /** Ждали слишком долго: вебхук ещё не пришёл, доступ откроется сам. */
  pending: boolean;
  reload: () => void;
};

/**
 * Статус прав exam и constitution с сервера. Клиент ничего не выдаёт: после возврата с оплаты (?billing=success)
 * просто опрашивает /api/exam/access, пока вебхук не изменит сроки (или нужное право не станет оплаченным).
 * onChange вызывается, когда сроки изменились — родитель перезагружает платный контент.
 */
export function useAccessStatus({
  focus,
  refreshKey = 0,
  onChange,
  enabled = true,
}: {
  focus: ReturnSection;
  refreshKey?: number;
  onChange?: (access: AccessStatus) => void;
  /** false — платный UI выключен (VITE_EXAM_UI), на сервер не ходим. */
  enabled?: boolean;
}): AccessView {
  const { authUser, authReady } = useAppContext();
  const uid = authUser?.uid ?? null;
  const [access, setAccess] = useState<AccessStatus>(NO_ACCESS);
  const [state, setState] = useState<AccessView['state']>('loading');
  const [awaiting, setAwaiting] = useState(() => enabled && typeof window !== 'undefined' && isBillingReturn(window.location.search));
  const [polls, setPolls] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const baseline = useRef<string | null>(awaiting ? readBaseline() : null);
  const awaitingInitializedRef = useRef(awaiting);
  const urlCleanedRef = useRef(false);
  const lastSignature = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!enabled || awaitingInitializedRef.current) return;
    awaitingInitializedRef.current = true;
    if (typeof window === 'undefined' || !isBillingReturn(window.location.search)) return;
    baseline.current = readBaseline();
    setAwaiting(true);
  }, [enabled]);

  // Адрес без ?billing=…, чтобы перезагрузка страницы не запускала ожидание оплаты заново.
  useEffect(() => {
    if (!awaiting || urlCleanedRef.current) return;
    urlCleanedRef.current = true;
    try {
      window.history.replaceState(window.history.state, '', withoutBillingReturn(window.location.href));
    } catch { /* адрес не меняется — не страшно */ }
  }, [awaiting]);

  useEffect(() => {
    if (!enabled || !authReady) return;
    if (!uid) {
      setAccess(NO_ACCESS);
      setState('guest');
      setAwaiting(false);
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const headers = await authHeaders();
        const res = await fetchAccessStatus(headers, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (res.status === 'ok') {
          setAccess(res.access);
          setState('ready');
          const signature = accessSignature(res.access);
          if (lastSignature.current !== null && lastSignature.current !== signature) onChangeRef.current?.(res.access);
          lastSignature.current = signature;
        } else {
          setState('error');
        }
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, [enabled, uid, authReady, refreshKey, reloadKey]);

  useEffect(() => {
    if (!awaiting || state !== 'ready') return;
    const done =
      baseline.current !== null
        ? accessSignature(access) !== baseline.current
        : focus === 'settings'
          ? access.exam.paid || access.constitution.paid
          : access[focus].paid;
    if (done) {
      setAwaiting(false);
      return;
    }
    if (polls >= PAYMENT_POLL_TRIES) return;
    const timer = window.setTimeout(() => {
      setPolls(value => value + 1);
      setReloadKey(value => value + 1);
    }, PAYMENT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [awaiting, state, access, focus, polls]);

  const reload = useCallback(() => {
    setState('loading');
    setReloadKey(value => value + 1);
  }, []);

  return { access, state, awaiting, pending: awaiting && polls >= PAYMENT_POLL_TRIES, reload };
}
