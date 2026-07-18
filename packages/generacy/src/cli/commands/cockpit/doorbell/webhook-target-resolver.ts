/**
 * `resolveWebhookTargets` — resolves the epic ref set into a primary-first,
 * deduped `Array<{owner, repo}>` for the doorbell's webhook-config discovery
 * stage. Never throws: any `resolveEpic` failure folds into `[]` + one warn.
 *
 * Contract: `specs/988-summary-cockpit-auto-doorbell/contracts/webhook-target-resolver.md`.
 */
import { resolveEpic, type GhWrapper } from '@generacy-ai/cockpit';

export interface ResolveWebhookTargetsInput {
  epicRef: string;
  gh: GhWrapper;
  logger?: { warn: (msg: string) => void };
}

function splitRepo(
  value: string,
  logger?: { warn: (msg: string) => void },
): { owner: string; repo: string } | null {
  const parts = value.split('/');
  if (parts.length !== 2) {
    logger?.warn(
      `cockpit doorbell: webhook-target: skipping malformed repo "${value}"`,
    );
    return null;
  }
  const [owner, repo] = parts;
  if (owner == null || owner === '' || repo == null || repo === '') {
    logger?.warn(
      `cockpit doorbell: webhook-target: skipping malformed repo "${value}"`,
    );
    return null;
  }
  return { owner, repo };
}

export async function resolveWebhookTargets(
  input: ResolveWebhookTargetsInput,
): Promise<Array<{ owner: string; repo: string }>> {
  let resolved;
  try {
    const options: Parameters<typeof resolveEpic>[0] = {
      epicRef: input.epicRef,
      gh: input.gh,
    };
    if (input.logger != null) options.logger = input.logger;
    resolved = await resolveEpic(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.warn(
      `cockpit doorbell: webhook-target resolution failed: ${message}`,
    );
    return [];
  }
  const primary = resolved.epic.repo;
  const ordered = [
    primary,
    ...resolved.repos.filter((r) => r !== primary),
  ];
  const out: Array<{ owner: string; repo: string }> = [];
  for (const value of ordered) {
    const split = splitRepo(value, input.logger);
    if (split != null) out.push(split);
  }
  return out;
}
