import type {
  CockpitConfig,
  GhWrapper,
} from '@generacy-ai/cockpit';
import { resolveEpicIssues } from '@generacy-ai/cockpit';

export type Scope =
  | { kind: 'epic'; owner: string; repo: string; ownerRepo: string; issues: number[] }
  | { kind: 'repos'; repos: string[] };

const EPIC_REGEX = /^([^/]+)\/([^/]+)#(\d+)$/;

export interface ResolveScopeOptions {
  epic?: string | undefined;
  reposOverride?: string[] | undefined;
  config: CockpitConfig;
  gh: GhWrapper;
  cwd?: string;
  logger?: { warn: (msg: string) => void };
}

export async function resolveScope(opts: ResolveScopeOptions): Promise<Scope> {
  if (opts.epic != null && opts.epic.length > 0) {
    const m = EPIC_REGEX.exec(opts.epic);
    if (m == null) {
      throw new Error('--epic must be owner/repo#NNN');
    }
    const owner = m[1]!;
    const repo = m[2]!;
    const issueNumber = Number.parseInt(m[3]!, 10);
    const issues = await resolveEpicIssues(issueNumber, owner, repo, {
      gh: opts.gh,
      ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
      ...(opts.logger != null ? { logger: opts.logger } : {}),
    });
    return {
      kind: 'epic',
      owner,
      repo,
      ownerRepo: `${owner}/${repo}`,
      issues,
    };
  }

  const repos =
    opts.reposOverride != null && opts.reposOverride.length > 0
      ? opts.reposOverride
      : opts.config.repos;
  return { kind: 'repos', repos };
}
