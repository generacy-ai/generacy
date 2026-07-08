import { Command } from 'commander';
import {
  GhCliWrapper,
  LoudResolverError,
  resolveEpic,
  type CommandRunner,
  type GhWrapper,
  type Issue,
} from '@generacy-ai/cockpit';
import { resolveIssueContext } from './resolver.js';
import { listAllIssues } from './shared/pagination.js';
import { classifyIssue } from './shared/classify-issue.js';
import { rollup } from './watch/check-rollup.js';
import { buildStatusRow, type StatusRow } from './status/row.js';
import { groupRows } from './status/group.js';
import { renderTable, renderJsonEnvelope } from './status/render-table.js';
import { chalkColorizer, identityColorizer } from './status/color.js';

interface StatusCliOptions {
  json?: boolean;
}

function isPullRequest(issue: Issue): boolean {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) return true;
  return issue.labels.includes('type:pr');
}

export interface StatusDeps {
  gh?: GhWrapper;
  runner?: CommandRunner;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  logger?: { warn: (msg: string) => void };
}

export async function runStatus(
  epicRef: string | undefined,
  options: StatusCliOptions,
  deps: StatusDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  if (epicRef == null || epicRef.trim() === '') {
    stderr('cockpit status: parse issue: issue argument is required');
    return 2;
  }

  const logger = deps.logger ?? { warn: (msg: string) => process.stderr.write(`${msg}\n`) };

  let expandedRef: string;
  let gh: GhWrapper;
  try {
    const resolvedCtx = await resolveIssueContext({ issue: epicRef, runner: deps.runner });
    expandedRef = `${resolvedCtx.ref.nwo}#${resolvedCtx.ref.number}`;
    gh = deps.gh ?? resolvedCtx.gh;
  } catch (err) {
    stderr(`cockpit status: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  let resolved;
  try {
    resolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
  } catch (err) {
    stderr(`cockpit status: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof LoudResolverError && err.code === 'INVALID_EPIC_REF') {
      return 2;
    }
    return 1;
  }

  const numbersByRepo = new Map<string, number[]>();
  for (const ref of resolved.parsed.allRefs) {
    const list = numbersByRepo.get(ref.repo);
    if (list != null) list.push(ref.number);
    else numbersByRepo.set(ref.repo, [ref.number]);
  }
  const repoBatches = [...numbersByRepo.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([repo, numbers]) => ({
      repo,
      query: `repo:${repo} ${numbers.map((n) => String(n)).join(' ')}`,
    }));

  const membershipByKey = new Map<string, string[]>();
  for (const phase of resolved.parsed.phases) {
    for (const ref of phase.refs) {
      const key = `${ref.repo}#${ref.number}`;
      const memberships = membershipByKey.get(key);
      if (memberships != null) memberships.push(phase.token);
      else membershipByKey.set(key, [phase.token]);
    }
  }

  const rows: StatusRow[] = [];
  for (const { repo, query } of repoBatches) {
    let issues: Issue[] = [];
    try {
      issues = await listAllIssues(gh, query, { logger });
    } catch (err) {
      stderr(
        `cockpit status: failed to list issues for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const issue of issues) {
      const classified = classifyIssue(issue.labels);
      const isPr = isPullRequest(issue);
      let prNumber: number | null = null;
      if (isPr) {
        prNumber = issue.number;
      } else {
        try {
          prNumber = await gh.resolveIssueToPR(repo, issue.number);
        } catch {
          prNumber = null;
        }
      }
      let checks: 'pending' | 'success' | 'failure' | 'none' | 'error' = 'none';
      if (prNumber != null) {
        try {
          const checkRuns = await gh.getPullRequestCheckRuns(repo, prNumber);
          checks = rollup(checkRuns);
        } catch {
          checks = 'error';
        }
      }
      const key = `${repo}#${issue.number}`;
      const memberships = membershipByKey.get(key);
      const phaseTokens: (string | null)[] =
        memberships != null && memberships.length > 0 ? memberships : [null];
      for (const phaseToken of phaseTokens) {
        rows.push(
          buildStatusRow(
            repo,
            issue,
            classified,
            isPr ? 'pr' : 'issue',
            prNumber,
            checks,
            phaseToken,
          ),
        );
      }
    }
  }

  const groups = groupRows(rows, resolved.parsed.phases, resolved.epic.repo);
  const orderedRows = groups.flatMap((g) => g.rows);

  if (options.json === true) {
    const [ownerStr, repoStr] = resolved.epic.repo.split('/');
    const line = renderJsonEnvelope(
      { owner: ownerStr!, repo: repoStr!, issue: resolved.epic.number },
      orderedRows,
    );
    stdout(line);
    return 0;
  }

  const tty = process.stdout.isTTY === true;
  const colorizer = tty ? chalkColorizer : identityColorizer;
  const table = renderTable(groups, { tty, json: false, colorizer });
  stdout(table);
  return 0;
}

export function statusCommand(): Command {
  return new Command('status')
    .description("Print a one-shot snapshot of every ref in the epic body's phases.")
    .argument(
      '<epic-ref>',
      'Epic ref. Accepts <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.',
    )
    .option('--json', 'Emit a single-line JSON envelope and exit. Disables color.', false)
    .action(async (epicRef: string, options: StatusCliOptions) => {
      const code = await runStatus(epicRef, options);
      process.exit(code);
    });
}
