/**
 * `runStartupRetry` — envelope around a Promise-returning startup task that
 * survives transient failures and exits distinctively on permanent ones.
 * Replaces the doorbell's silent `exit(2)` on first-hiccup failure.
 *
 * Contract: `specs/980-summary-978-shipped-working/contracts/startup-retry.md`.
 */
import type { RateLimitScheduler } from '@generacy-ai/cockpit';

export type GhErrorClass =
  | { kind: 'retriable'; hint: string }
  | { kind: 'permanent'; reason: string };

export type StartupRetryLabel = 'acquireEpicBus' | 'resolveEpic';

export interface StartupRetryOptions<T> {
  task: () => Promise<T>;
  label: StartupRetryLabel;
  rateLimitScheduler: RateLimitScheduler;
  abortSignal: AbortSignal;
  stderr: { write(chunk: string): boolean | void };
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  classify?: (err: unknown) => GhErrorClass;
  initialWindowMs?: number;
  lateWindowIntervalMs?: number;
}

export type StartupRetryOutcome<T> =
  | { kind: 'success'; value: T }
  | { kind: 'permanent'; reason: string }
  | { kind: 'aborted' };

const DEFAULT_INITIAL_WINDOW_MS = 2 * 60_000;
const DEFAULT_LATE_WINDOW_INTERVAL_MS = 5 * 60_000;

function errMessage(err: unknown): string {
  if (err == null) return '';
  if (err instanceof Error) return err.message;
  return String(err);
}

function errCode(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const RETRIABLE_NODE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
]);

/**
 * Deterministic mapping from a raw `gh`-call error to `GhErrorClass`.
 *
 * Retriable rules are evaluated first (node error codes → socket-hang-up →
 * HTTP 429/5xx). Permanent rules follow (401/Bad credentials → 403 SAML/
 * scope → 404 not-found → JSON-parse failure). Default: permanent/unknown.
 *
 * See `contracts/startup-retry.md § Error classifier` for full rationale.
 */
export function classifyGhError(err: unknown): GhErrorClass {
  const message = errMessage(err);
  const code = errCode(err);

  // Retriable: node error codes.
  if (code != null && RETRIABLE_NODE_CODES.has(code)) {
    return { kind: 'retriable', hint: code.toLowerCase() };
  }
  // Retriable: socket hang up.
  if (/socket hang up/i.test(message)) {
    return { kind: 'retriable', hint: 'socket-hang-up' };
  }
  // Retriable: HTTP 429 / 5xx.
  const retriableHttp = message.match(/\bHTTP\s+(429|500|502|503|504)\b/);
  if (retriableHttp) {
    return { kind: 'retriable', hint: `http-${retriableHttp[1]}` };
  }
  // Retriable: GitHub primary/secondary rate limits. These do NOT reliably
  // surface as "HTTP 429" — the GraphQL primary limit arrives as plain text
  // ("API rate limit exceeded" / "...rate limit already exceeded...") with no
  // HTTP status, and the secondary/abuse limit arrives as HTTP 403. They MUST
  // be matched here, before the permanent 401/403 rules below, or a
  // rate-limited `gh` call is misclassified as permanent and the doorbell
  // exit(3)s instead of retrying — the exact failure this envelope exists to
  // prevent, since rate-limiting is the dominant transient `gh` failure.
  if (
    /rate limit (?:already )?exceeded/i.test(message) ||
    /secondary rate limit/i.test(message) ||
    /abuse detection/i.test(message)
  ) {
    return { kind: 'retriable', hint: 'rate-limit' };
  }

  // Permanent: 401 / Bad credentials.
  if (/\bHTTP\s+401\b/.test(message) || /Bad credentials/i.test(message)) {
    return { kind: 'permanent', reason: 'bad-credentials' };
  }
  // Permanent: 403 / SAML / scope.
  if (
    /\bHTTP\s+403\b/.test(message) ||
    /SAML|scope|not accessible by/i.test(message)
  ) {
    return { kind: 'permanent', reason: 'scope-or-sso' };
  }
  // Permanent: 404 / not-found.
  if (
    /\bHTTP\s+404\b/.test(message) ||
    /Could not resolve to (an Issue|a Repository)/i.test(message)
  ) {
    return { kind: 'permanent', reason: 'not-found' };
  }
  // Permanent: malformed output.
  if (/parsing|expected JSON|invalid character/i.test(message)) {
    return { kind: 'permanent', reason: 'malformed-output' };
  }

  return { kind: 'permanent', reason: 'unknown' };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runStartupRetry<T>(
  opts: StartupRetryOptions<T>,
): Promise<StartupRetryOutcome<T>> {
  const {
    task,
    label,
    rateLimitScheduler,
    abortSignal,
    stderr,
    logger,
    now = () => Date.now(),
    sleep = defaultSleep,
    classify = classifyGhError,
    initialWindowMs = DEFAULT_INITIAL_WINDOW_MS,
    lateWindowIntervalMs = DEFAULT_LATE_WINDOW_INTERVAL_MS,
  } = opts;

  const startedAt = now();
  let attempt = 0;
  let firstRetriableEmitted = false;
  let phase: 'initial' | 'late' = 'initial';
  let recoveredFromLate = false;

  for (;;) {
    if (abortSignal.aborted) return { kind: 'aborted' };
    attempt += 1;
    try {
      const value = await task();
      if (recoveredFromLate) {
        stderr.write(
          `cockpit doorbell: startup-retry-recovered label=${label}\n`,
        );
      }
      return { kind: 'success', value };
    } catch (err) {
      const cls = classify(err);
      if (cls.kind === 'permanent') {
        stderr.write(
          `cockpit doorbell: permanent-error label=${label} reason=${cls.reason}\n`,
        );
        return { kind: 'permanent', reason: cls.reason };
      }

      // Retriable branch.
      if (phase === 'initial') {
        if (!firstRetriableEmitted) {
          stderr.write(
            `cockpit doorbell: startup-retry label=${label} reason=${cls.hint} attempt=${attempt}\n`,
          );
          firstRetriableEmitted = true;
        } else {
          logger.info?.(
            `cockpit doorbell: startup-retry label=${label} reason=${cls.hint} attempt=${attempt}`,
          );
        }
      } else {
        logger.info?.(
          `cockpit doorbell: startup-retry-late label=${label} reason=${cls.hint} attempt=${attempt}`,
        );
      }

      if (phase === 'initial' && now() - startedAt >= initialWindowMs) {
        stderr.write(
          `cockpit doorbell: startup-retry-exhausted label=${label} transitioning to late-startup retry\n`,
        );
        phase = 'late';
        recoveredFromLate = true;
      }

      const sleepMs =
        phase === 'initial'
          ? rateLimitScheduler.getCurrentIntervalMs()
          : lateWindowIntervalMs;
      await sleep(sleepMs, abortSignal);
      if (abortSignal.aborted) return { kind: 'aborted' };

      // Best-effort hook so the scheduler's watermark logic advances between
      // attempts. Failures are swallowed — the scheduler is defensive.
      if (phase === 'initial') {
        try {
          rateLimitScheduler.noteResponseHeaders({});
        } catch {
          /* best-effort */
        }
      }
    }
  }
}
