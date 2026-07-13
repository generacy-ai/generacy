import type { GhWrapper, IssueRef } from '@generacy-ai/cockpit';
import { ScopeContendedError } from './errors.js';
import { applyScopeMutation, type BodyShape, type ScopeMutation } from './writer.js';

export interface WriteScopeOptions {
  gh: GhWrapper;
  scope: IssueRef;
  mutation: ScopeMutation;
  maxAttempts?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface WriteScopeResult {
  noop: boolean;
  attempts: number;
  finalBody: string;
  shape: BodyShape;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = [100, 250, 500, 1000, 2000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read-modify-write-verify loop for concurrent-safe scope body mutations.
 * `applyScopeMutation` is idempotent, so a competing writer that already
 * applied our mutation causes the next retry to short-circuit as noop.
 * Terminal exhaustion throws `ScopeContendedError`.
 */
export async function writeScopeWithRetry(
  opts: WriteScopeOptions,
): Promise<WriteScopeResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const issue = await opts.gh.getIssue(opts.scope.repo, opts.scope.number);
    const body = issue.body ?? '';
    const result = applyScopeMutation(body, opts.mutation);

    if (result.noop) {
      return {
        noop: true,
        attempts: attempt,
        finalBody: body,
        shape: result.shape,
      };
    }

    await opts.gh.updateIssueBody(opts.scope.repo, opts.scope.number, result.body);

    const readback = await opts.gh.getIssue(opts.scope.repo, opts.scope.number);
    const verifyBody = readback.body ?? '';

    if (verifyBody === result.body) {
      return {
        noop: false,
        attempts: attempt,
        finalBody: verifyBody,
        shape: result.shape,
      };
    }

    if (attempt < maxAttempts) {
      await sleep(backoffMs[attempt - 1]!);
    }
  }

  throw new ScopeContendedError({
    attempts: maxAttempts,
    ref: opts.mutation.ref,
    mutation: opts.mutation.kind,
    scope: opts.scope,
  });
}
