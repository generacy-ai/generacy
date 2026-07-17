/**
 * #958 — `cockpit_relay_clarify_answers` MCP tool.
 *
 * Wraps `runClarifyRelay` (which posts a marker-stamped comment via
 * `formatClarificationAnswerComment` and applies `completed:clarification`).
 * The skill invokes this tool with a structured `{ [questionNumber]: string }`
 * payload — the freehand `gh issue comment` step in the pre-#958 skill is
 * retired here. That's the FR-003 load-bearing companion.
 *
 * Envelope mirrors `cockpit_advance` — Zod-validated input, `wrapToolBoundary`
 * for CockpitExit → ToolResult mapping, `normalizeIssueRef` for the MCP-layer
 * qualified-ref requirement.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runClarifyRelay, type ClarifyRelayDeps } from '../../clarify-relay.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitRelayClarifyAnswersInputSchema,
  type IssueRefInput,
} from '../schemas.js';

export interface CockpitRelayClarifyAnswersInput {
  issue: IssueRefInput;
  batch: number;
  answers: Record<number, string>;
  actor?: string;
}

export interface CockpitRelayClarifyAnswersData {
  ref: { owner: string; repo: string; number: number; nwo: string };
  batch: number;
  action: 'relayed' | 'already-relayed';
  completedLabel: 'completed:clarification';
  commentUrl?: string;
  noop?: true;
}

export interface CockpitRelayClarifyAnswersDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: ClarifyRelayDeps['loadConfig'];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function cockpitRelayClarifyAnswers(
  input: CockpitRelayClarifyAnswersInput,
  deps: CockpitRelayClarifyAnswersDeps = {},
): Promise<ToolResult<CockpitRelayClarifyAnswersData>> {
  return wrapToolBoundary<CockpitRelayClarifyAnswersData>(async () => {
    const parsed = CockpitRelayClarifyAnswersInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => i.message).join('; ');
      return { status: 'error', class: 'invalid-args', detail };
    }

    const normalized = await normalizeIssueRef(parsed.data.issue, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!normalized.ok) return normalized.error;

    const relayDeps: ClarifyRelayDeps = {
      gh: deps.gh ?? normalized.value.gh,
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.loadConfig != null ? { loadConfig: deps.loadConfig } : {}),
      ...(deps.env != null ? { env: deps.env } : {}),
      ...(deps.now != null ? { now: deps.now } : {}),
    };

    const issueArg = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
    const relayInput: Parameters<typeof runClarifyRelay>[0] = {
      issue: issueArg,
      batch: parsed.data.batch,
      answers: parsed.data.answers,
      ...(parsed.data.actor != null ? { actor: parsed.data.actor } : {}),
    };
    const result = await runClarifyRelay(relayInput, relayDeps);

    const data: CockpitRelayClarifyAnswersData = {
      ref: normalized.value.ref,
      batch: result.batch,
      action: result.action,
      completedLabel: result.completedLabel,
      ...(result.commentUrl != null ? { commentUrl: result.commentUrl } : {}),
      ...(result.noop === true ? { noop: true } : {}),
    };

    return { status: 'ok', data };
  });
}
