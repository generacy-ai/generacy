/**
 * `resolveCockpitIdentity` — resolve the GitHub identity used by cockpit
 * subcommands (queue, advance), mirroring `packages/orchestrator/src/services/
 * identity.ts` precedence so App-credentialed clusters don't 403 on `gh api user`.
 *
 * Precedence (first non-null / non-empty / non-throwing tier wins):
 *   1a. `flag`                        — `--assignee <login>` CLI flag
 *   1b. `configAssignee`              — `cockpit.assignee` in `.generacy/config.yaml`
 *   2a. `env.CLUSTER_GITHUB_USERNAME` — cluster-wide env
 *   2b. `env.GH_USERNAME`             — cluster-wide env (wizard-delivered)
 *   3.  `gh.getCurrentUser()`         — `gh api user`
 *
 * Two modes:
 *   - `required` — throws `LoudIdentityError` naming all four knobs on all-miss.
 *   - `optional` — logs a warning naming all four knobs and returns
 *     `{ login: undefined, source: 'none' }`.
 */
import type { GhWrapper } from '@generacy-ai/cockpit';

export type IdentitySource =
  | 'flag'
  | 'config'
  | 'CLUSTER_GITHUB_USERNAME'
  | 'GH_USERNAME'
  | 'gh-api'
  | 'none';

export interface ResolveCockpitIdentityInput {
  flag?: string;
  configAssignee?: string;
  gh: Pick<GhWrapper, 'getCurrentUser'>;
  logger: { warn(msg: string): void; info?(msg: string): void };
  verb: string;
  mode: 'required' | 'optional';
  env?: NodeJS.ProcessEnv;
}

export type ResolveCockpitIdentityResult =
  | { login: string; source: Exclude<IdentitySource, 'none'> }
  | { login: undefined; source: 'none' };

export class LoudIdentityError extends Error {
  readonly code = 'IDENTITY_UNRESOLVED' as const;
  readonly verb: string;
  constructor(verb: string, message: string) {
    super(message);
    this.name = 'LoudIdentityError';
    this.verb = verb;
  }
}

function buildFourKnobMessage(verb: string): string {
  return (
    `cockpit ${verb}: unable to resolve GitHub identity.\n` +
    'Set one of the following:\n' +
    '  --assignee <login>                        (flag, per-invocation)\n' +
    '  cockpit.assignee in .generacy/config.yaml (per-repo)\n' +
    '  CLUSTER_GITHUB_USERNAME                   (env, cluster-wide)\n' +
    '  GH_USERNAME                               (env, cluster-wide)\n' +
    'Or authenticate `gh` for a user-token (gh auth login) so `gh api user` can resolve.'
  );
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

export async function resolveCockpitIdentity(
  input: ResolveCockpitIdentityInput & { mode: 'required' },
): Promise<{ login: string; source: Exclude<IdentitySource, 'none'> }>;
export async function resolveCockpitIdentity(
  input: ResolveCockpitIdentityInput & { mode: 'optional' },
): Promise<ResolveCockpitIdentityResult>;
export async function resolveCockpitIdentity(
  input: ResolveCockpitIdentityInput,
): Promise<ResolveCockpitIdentityResult>;
export async function resolveCockpitIdentity(
  input: ResolveCockpitIdentityInput,
): Promise<ResolveCockpitIdentityResult> {
  const env = input.env ?? process.env;
  const { flag, configAssignee, gh, logger, verb, mode } = input;

  if (nonEmpty(flag)) {
    logger.info?.(`cockpit ${verb}: identity resolved from --assignee flag (${flag})`);
    return { login: flag, source: 'flag' };
  }

  if (nonEmpty(configAssignee)) {
    logger.info?.(
      `cockpit ${verb}: identity resolved from cockpit.assignee config (${configAssignee})`,
    );
    return { login: configAssignee, source: 'config' };
  }

  const clusterEnv = env['CLUSTER_GITHUB_USERNAME'];
  if (nonEmpty(clusterEnv)) {
    logger.info?.(
      `cockpit ${verb}: identity resolved from CLUSTER_GITHUB_USERNAME (${clusterEnv})`,
    );
    return { login: clusterEnv, source: 'CLUSTER_GITHUB_USERNAME' };
  }

  const ghEnv = env['GH_USERNAME'];
  if (nonEmpty(ghEnv)) {
    logger.info?.(`cockpit ${verb}: identity resolved from GH_USERNAME (${ghEnv})`);
    return { login: ghEnv, source: 'GH_USERNAME' };
  }

  try {
    const login = await gh.getCurrentUser();
    if (nonEmpty(login)) {
      logger.info?.(`cockpit ${verb}: identity resolved from gh api user (${login})`);
      return { login, source: 'gh-api' };
    }
  } catch (err) {
    if (mode === 'optional') {
      const msg = err instanceof Error ? err.message : String(err);
      logger.info?.(`cockpit ${verb}: gh api user failed: ${msg}`);
    }
    // Fall through to the four-knob failure branch. The individual error is
    // not surfaced in the loud message — the four knobs are the actionable fix.
  }

  const message = buildFourKnobMessage(verb);

  if (mode === 'required') {
    throw new LoudIdentityError(verb, message);
  }

  logger.warn(`warning: ${message}`);
  return { login: undefined, source: 'none' };
}
