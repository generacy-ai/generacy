import { normalizeLogin } from '@generacy-ai/workflow-engine';

/**
 * Minimal logger interface — mirrors identity.ts to avoid pulling in pino
 * types at the resolver's leaf module.
 */
interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Resolve the acting identity used by the `cluster-identity` trust rule.
 *
 * Distinct from `resolveClusterIdentity()` (which resolves the assignee
 * login for `filterByAssignee`). This resolver reads exactly one env var —
 * `CLUSTER_ACTING_LOGIN` — and normalizes the result. On unset/empty, it
 * emits a single boot-time `error` line naming the tried chain and
 * returns `undefined`; the trust rule then never fires and callers fall
 * through to tier-based trust (degraded but observable).
 *
 * See specs/874-…/contracts/acting-identity-resolver.contract.md.
 */
export function resolveActingIdentity(logger: Logger): string | undefined {
  const raw = process.env['CLUSTER_ACTING_LOGIN'];
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') {
    logger.error(
      { triedChain: ['CLUSTER_ACTING_LOGIN'], outcome: 'unset-or-empty' },
      'Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai).',
    );
    return undefined;
  }

  const normalized = normalizeLogin(trimmed);
  logger.info(
    { actingLogin: normalized, source: 'env' },
    `Acting identity resolved: ${normalized} (from CLUSTER_ACTING_LOGIN)`,
  );
  return normalized;
}
