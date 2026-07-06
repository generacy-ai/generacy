import { Command } from 'commander';
import {
  GhCliWrapper,
  LoudResolverError,
  resolveEpic,
  type GhWrapper,
  type Issue,
} from '@generacy-ai/cockpit';
import { listAllIssues } from './shared/pagination.js';
import { classifyIssue } from './shared/classify-issue.js';
import { rollup } from './watch/check-rollup.js';
import { buildStatusRow, type StatusRow } from './status/row.js';
import { groupRows } from './status/group.js';
import { renderTable, renderJsonEnvelope } from './status/render-table.js';
import { chalkColorizer, identityColorizer } from './status/color.js';

interface StatusCliOptions {
  epic?: string;
  json?: boolean;
}

function isPullRequest(issue: Issue): boolean {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) return true;
  return issue.labels.includes('type:pr');
}

export interface StatusDeps {
  gh?: GhWrapper;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  logger?: { warn: (msg: string) => void };
}

export async function runStatus(
  options: StatusCliOptions,
  deps: StatusDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  if (options.epic == null || options.epic.trim() === '') {
    stderr('cockpit status: --epic is required (format owner/repo#N)');
    return 2;
  }

  const gh = deps.gh ?? new GhCliWrapper();
  const logger = deps.logger ?? { warn: (msg: string) => process.stderr.write(`${msg}\n`) };

  let resolved;
  try {
    resolved = await resolveEpic({ epicRef: options.epic, gh, logger });
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
      let checks: 'pending' | 'success' | 'failure' | 'none' = 'none';
      if (prNumber != null) {
        try {
          const checkRuns = await gh.getPullRequestCheckRuns(repo, prNumber);
          checks = rollup(checkRuns);
        } catch {
          checks = 'none';
        }
      }
      rows.push(
        buildStatusRow(
          repo,
          issue,
          classified,
          isPr ? 'pr' : 'issue',
          prNumber,
          checks,
        ),
      );
    }
  }

  if (options.json === true) {
    const [ownerStr, repoStr] = resolved.epic.repo.split('/');
    const line = renderJsonEnvelope(
      { owner: ownerStr!, repo: repoStr!, issue: resolved.epic.number },
      rows,
    );
    stdout(line);
    return 0;
  }

  const groups = groupRows(rows, resolved.epic.repo);
  const tty = process.stdout.isTTY === true;
  const colorizer = tty ? chalkColorizer : identityColorizer;
  const table = renderTable(groups, { tty, json: false, colorizer });
  stdout(table);
  return 0;
}

export function statusCommand(): Command {
  return new Command('status')
    .description("Print a one-shot snapshot of every ref in the epic body's phases.")
    .requiredOption('--epic <ownerRepoIssue>', 'Scope to a single epic. Format owner/repo#N.')
    .option('--json', 'Emit a single-line JSON envelope and exit. Disables color.', false)
    .action(async (options: StatusCliOptions) => {
      const code = await runStatus(options);
      process.exit(code);
    });
}
