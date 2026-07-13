/**
 * `cockpit_queue` MCP tool handler.
 *
 * Wraps `runQueue` with the confirmation prompt short-circuited to `true`
 * (agents don't type "y" — the whole point of the MCP transport is to
 * eliminate that class of round). Returns the structured `queued`/`skipped`
 * arrays derived from `QueueResult.rows`.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runQueue, type QueueCommandDeps, type QueueResult } from '../../queue.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitQueueInputSchema, type EpicRefInput } from '../schemas.js';

export interface CockpitQueueInput {
  epic: EpicRefInput;
  phase: string;
}

export interface CockpitQueueData {
  epic: { owner: string; repo: string; number: number };
  phase: string;
  queued: Array<{ repo: string; number: number; url: string }>;
  skipped: Array<{ repo: string; number: number; reason: string }>;
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
): Promise<ToolResult<CockpitQueueData>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitQueueInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
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
