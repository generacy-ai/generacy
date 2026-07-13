/**
 * `cockpit_queue` MCP tool handler.
 *
 * Wraps `runQueue` with the confirmation prompt short-circuited to `true`
 * (agents don't type "y" — the whole point of the MCP transport is to
 * eliminate that class of round). Returns the structured `queued`/`skipped`
 * arrays derived from `QueueResult.rows`.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import {
  runQueue,
  runQueueSingleIssue,
  type QueueCommandDeps,
  type QueueResult,
} from '../../queue.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitQueueInputSchema,
  type EpicRefInput,
  type IssueRefInput,
} from '../schemas.js';

export interface CockpitQueuePhaseInput {
  epic: EpicRefInput;
  phase: string;
}

export interface CockpitQueueIssueInputShape {
  issue: IssueRefInput;
}

export type CockpitQueueInput = CockpitQueuePhaseInput | CockpitQueueIssueInputShape;

export interface CockpitQueueData {
  epic: { owner: string; repo: string; number: number };
  phase: string;
  queued: Array<{ repo: string; number: number; url: string }>;
  skipped: Array<{ repo: string; number: number; reason: string }>;
}

export interface CockpitQueueIssueData {
  issue: { owner: string; repo: string; number: number };
  outcome: 'queued' | 'skipped';
  reason?: 'closed' | 'already-labeled' | 'not-found';
  workflowLabel: string;
  assignee: string;
  url: string;
}

export interface CockpitQueueDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  cockpitGh?: GhWrapper;
  loadConfig?: QueueCommandDeps['loadConfig'];
  fetchPlan?: QueueCommandDeps['fetchPlan'];
}

function buildQueueData(
  epicOwner: string,
  epicRepo: string,
  epicNumber: number,
  phase: string,
  result: QueueResult,
): CockpitQueueData {
  const queued: CockpitQueueData['queued'] = [];
  const skipped: CockpitQueueData['skipped'] = [];
  for (const row of result.rows) {
    if (row.eligibility.kind === 'eligible') {
      queued.push({
        repo: row.ref.repo,
        number: row.ref.number,
        url: `https://github.com/${row.ref.repo}/issues/${row.ref.number}`,
      });
    } else {
      skipped.push({
        repo: row.ref.repo,
        number: row.ref.number,
        reason: row.eligibility.reason,
      });
    }
  }
  return {
    epic: { owner: epicOwner, repo: epicRepo, number: epicNumber },
    phase,
    queued,
    skipped,
  };
}

export function cockpitQueue(
  input: CockpitQueueInput,
  deps: CockpitQueueDeps = {},
): Promise<ToolResult<CockpitQueueData | CockpitQueueIssueData>> {
  return wrapToolBoundary<CockpitQueueData | CockpitQueueIssueData>(async () => {
    const parsed = CockpitQueueInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    // Discriminated union: `issue` = single-issue form, `epic + phase` = phase form.
    if ('issue' in parsed.data) {
      const refN = await normalizeIssueRef(parsed.data.issue, {
        expects: 'issue',
        ...(deps.runner != null ? { runner: deps.runner } : {}),
        ...(deps.gh != null ? { gh: deps.gh } : {}),
      });
      if (!refN.ok) return refN.error;

      const captured: string[] = [];
      const stderrLines: string[] = [];
      const queueDeps: QueueCommandDeps = {
        gh: deps.gh ?? refN.value.gh,
        ...(deps.cockpitGh != null ? { cockpitGh: deps.cockpitGh } : {}),
        ...(deps.runner != null ? { runner: deps.runner } : {}),
        ...(deps.loadConfig != null ? { loadConfig: deps.loadConfig } : {}),
        stdout: (line: string) => captured.push(line),
        stderr: (line: string) => stderrLines.push(line),
        prompt: async () => true,
      };

      const issueArg = `${refN.value.ref.nwo}#${refN.value.ref.number}`;
      const result = await runQueueSingleIssue(issueArg, { yes: true }, queueDeps);

      const data: CockpitQueueIssueData = {
        issue: {
          owner: refN.value.ref.owner,
          repo: refN.value.ref.repo,
          number: refN.value.ref.number,
        },
        outcome: result.row.eligibility.kind === 'eligible' ? 'queued' : 'skipped',
        workflowLabel: result.workflowLabel,
        assignee: result.assignee,
        url: `https://github.com/${result.ref.repo}/issues/${result.ref.number}`,
      };
      if (result.row.eligibility.kind === 'skip') {
        data.reason = result.row.eligibility.reason as CockpitQueueIssueData['reason'];
      }
      return { status: 'ok', data };
    }

    const normalized = await normalizeIssueRef(parsed.data.epic, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!normalized.ok) return normalized.error;

    const captured: string[] = [];
    const stderrLines: string[] = [];
    const queueDeps: QueueCommandDeps = {
      gh: deps.gh ?? normalized.value.gh,
      ...(deps.cockpitGh != null ? { cockpitGh: deps.cockpitGh } : {}),
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.loadConfig != null ? { loadConfig: deps.loadConfig } : {}),
      ...(deps.fetchPlan != null ? { fetchPlan: deps.fetchPlan } : {}),
      stdout: (line: string) => captured.push(line),
      stderr: (line: string) => stderrLines.push(line),
      prompt: async () => true,
    };

    const epicArg = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
    const result = await runQueue(
      epicArg,
      parsed.data.phase,
      { yes: true },
      queueDeps,
    );

    return {
      status: 'ok',
      data: buildQueueData(
        normalized.value.ref.owner,
        normalized.value.ref.repo,
        normalized.value.ref.number,
        parsed.data.phase,
        result,
      ),
    };
  });
}
