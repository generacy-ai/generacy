import { Command } from 'commander';
import {
  GhCliWrapper,
  createOrchestratorClient,
  loadCockpitConfig,
  readJournalLiveness,
  type Issue,
} from '@generacy-ai/cockpit';
import { resolveScope } from './shared/scoping.js';
import { listAllIssues } from './shared/pagination.js';
import { classifyIssue } from './shared/classify-issue.js';
import { getFooter, renderFooter } from './shared/orchestrator-footer.js';
import { resolveOrchestratorToken } from './shared/orchestrator-token.js';
import { createFirstFailureWarner } from './shared/orchestrator-warn.js';
import { rollup } from './watch/check-rollup.js';
import { buildStatusRow, type StatusRow } from './status/row.js';
import { groupRows } from './status/group.js';
import { renderTable, renderJsonEnvelope } from './status/render-table.js';
import { chalkColorizer, identityColorizer } from './status/color.js';

interface StatusCliOptions {
  epic?: string;
  repos?: string;
  json?: boolean;
}

function parseRepos(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isPullRequest(issue: Issue): boolean {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) return true;
  return issue.labels.includes('type:pr');
}

function parseEpicIssueNumber(epic: string | undefined): number | undefined {
  if (epic == null) return undefined;
  const m = /^[^/]+\/[^/]+#(\d+)$/.exec(epic);
  if (m == null) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function statusCommand(): Command {
  return new Command('status')
    .description('Print a one-shot snapshot of every epic-scoped (or repo-scoped) issue/PR.')
    .option('--epic <ownerRepoIssue>', 'Scope to a single epic. Format owner/repo#NNN.')
    .option('--repos <list>', 'Comma-separated owner/name list to override cockpit.repos.')
    .option('--json', 'Emit a single-line JSON envelope and exit. Disables color.', false)
    .action(async (options: StatusCliOptions) => {
      try {
        const reposOverride = parseRepos(options.repos);
        const loaded = await loadCockpitConfig();
        const gh = new GhCliWrapper();

        let scope;
        try {
          scope = await resolveScope({
            ...(options.epic != null ? { epic: options.epic } : {}),
            ...(reposOverride != null ? { reposOverride } : {}),
            config: loaded.config,
            gh,
            logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
          });
        } catch (err) {
          process.stderr.write(`cockpit: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }

        const token = resolveOrchestratorToken({
          envValue: process.env.ORCHESTRATOR_API_TOKEN,
          configValue: loaded.config.orchestrator?.token,
        });
        const orchestratorOptions: { baseUrl?: string; token?: string } = {};
        if (loaded.config.orchestrator?.baseUrl != null) {
          orchestratorOptions.baseUrl = loaded.config.orchestrator.baseUrl;
        }
        if (token != null) {
          orchestratorOptions.token = token;
        }
        const orchestrator = createOrchestratorClient(orchestratorOptions);
        const warner = createFirstFailureWarner({
          write: (msg) => process.stderr.write(msg),
        });

        let repoBatches: Array<{ repo: string; query: string }>;
        if (scope.kind === 'epic') {
          const numbersByRepo = new Map<string, number[]>();
          for (const ref of scope.issues) {
            const list = numbersByRepo.get(ref.repo);
            if (list != null) list.push(ref.number);
            else numbersByRepo.set(ref.repo, [ref.number]);
          }
          repoBatches = [...numbersByRepo.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([repo, numbers]) => ({
              repo,
              query: `repo:${repo} ${numbers.map((n) => String(n)).join(' ')}`,
            }));
        } else {
          repoBatches = scope.repos.map((repo) => ({
            repo,
            query: `repo:${repo} is:open`,
          }));
        }

        const rows: StatusRow[] = [];
        for (const { repo, query } of repoBatches) {
          let issues: Issue[] = [];
          try {
            issues = await listAllIssues(gh, query, {
              logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
            });
          } catch (err) {
            process.stderr.write(
              `cockpit: failed to list issues for ${repo}: ${err instanceof Error ? err.message : String(err)}\n`,
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
            let liveness: { stuck: boolean; stuckReason: import('@generacy-ai/cockpit').StuckReason } | undefined;
            if (
              !isPr &&
              classified.state === 'active' &&
              classified.sourceLabel === 'agent:in-progress'
            ) {
              const result = await readJournalLiveness({
                issueNumber: issue.number,
                thresholdMinutes: loaded.config.stuckThresholdMinutes,
                logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
              });
              liveness = { stuck: result.stuck, stuckReason: result.stuckReason };
            }
            rows.push(
              buildStatusRow(
                repo,
                issue,
                classified,
                isPr ? 'pr' : 'issue',
                prNumber,
                checks,
                liveness,
              ),
            );
          }
        }

        const footer = await getFooter(orchestrator, 1500, warner);

        if (options.json === true) {
          const line = renderJsonEnvelope(scope, rows, footer, parseEpicIssueNumber(options.epic));
          process.stdout.write(`${line}\n`);
          process.exit(0);
        }

        const groups = groupRows(rows, scope);
        const tty = process.stdout.isTTY === true;
        const colorizer = tty ? chalkColorizer : identityColorizer;
        const table = renderTable(groups, { tty, json: false, colorizer });
        process.stdout.write(`${table}\n${renderFooter(footer)}\n`);
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `cockpit: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });
}
