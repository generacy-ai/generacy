import { Command } from 'commander';
import type { Logger } from 'pino';
import type { GhWrapper } from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { resolveContext } from './shared/resolve-context.js';
import {
  buildReviewContextPayload,
  serializeReviewContextJson,
} from './shared/review-context-json.js';

export interface RunReviewContextInput {
  gh: GhWrapper;
  issue: number;
  repo: string;
  logger: Logger;
}

export interface RunReviewContextResult {
  exitCode: 0 | 1;
  stdout: string;
}

export async function runReviewContext(
  input: RunReviewContextInput,
): Promise<RunReviewContextResult> {
  const { gh, issue, repo, logger } = input;

  const prRef = await gh.resolveIssueToPR(repo, issue);
  if (prRef == null) {
    logger.error({ issue, repo }, 'No PR resolved for issue');
    return { exitCode: 1, stdout: '' };
  }

  const [pr, checks] = await Promise.all([
    gh.getPullRequest(repo, prRef.number),
    gh.getPullRequestCheckRuns(repo, prRef.number),
  ]);

  const payload = buildReviewContextPayload({ pr, checks });
  return {
    exitCode: 0,
    stdout: serializeReviewContextJson(payload),
  };
}

export function cockpitReviewContextCommand(): Command {
  const cmd = new Command('review-context');
  cmd
    .description(
      'Emit a JSON object with PR metadata, unified diff, and check results — canonical input for the review skill',
    )
    .argument('<issue>', 'GitHub issue number')
    .option('--repo <repo>', 'Owner/name (inferred from cwd if absent)')
    .action(async (issueArg: string, opts: { repo?: string }) => {
      const issue = Number.parseInt(issueArg, 10);
      if (!Number.isInteger(issue) || issue <= 0) {
        throw new Error(`Invalid issue number: ${issueArg}`);
      }
      const logger = getLogger();
      const ctx = resolveContext({ issue, repo: opts.repo });
      const result = await runReviewContext({
        gh: ctx.gh,
        issue: ctx.issue,
        repo: ctx.repo,
        logger,
      });
      if (result.stdout.length > 0) {
        process.stdout.write(result.stdout);
      }
      process.exit(result.exitCode);
    });
  return cmd;
}
