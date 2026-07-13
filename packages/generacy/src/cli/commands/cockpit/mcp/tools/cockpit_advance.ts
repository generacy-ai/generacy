/**
 * `cockpit_advance` MCP tool handler.
 *
 * Wraps `runAdvance` (which throws `CockpitExit` on refusal / parse error /
 * transport failure). `wrapToolBoundary` maps thrown `CockpitExit` to a
 * typed `ToolErrorResult` via the exit-code table.
 *
 * Idempotent no-op (advance.ts:122-127): when `completed:<gate>` already
 * present, `runAdvance` returns without throwing but writes a stdout line
 * that starts with "already advanced". Represent this as
 * `{status: "ok", data: {..., noop: true, action: "already-advanced"}}`.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runAdvance, type AdvanceCommandDeps } from '../../advance.js';
import { normalizeIssueRef } from '../ref-input.js';
import { GATES } from '../../gate-vocabulary.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitAdvanceInputSchema,
  type IssueRefInput,
  type GateNameInput,
} from '../schemas.js';

export interface CockpitAdvanceInput {
  issue: IssueRefInput;
  gate: GateNameInput;
}

export interface CockpitAdvanceData {
  ref: { owner: string; repo: string; number: number; nwo: string };
  gate: string;
  action: 'advanced' | 'already-advanced';
  completedLabel: string;
  commentUrl?: string;
  noop?: true;
}

export interface CockpitAdvanceDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: AdvanceCommandDeps['loadConfig'];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function cockpitAdvance(
  input: CockpitAdvanceInput,
  deps: CockpitAdvanceDeps = {},
): Promise<ToolResult<CockpitAdvanceData>> {
  return wrapToolBoundary<CockpitAdvanceData>(async () => {
    const parsed = CockpitAdvanceInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => i.message).join('; ');
      const cls: 'invalid-args' | 'unknown-gate' = /Invalid enum value|invalid_enum_value/i.test(
        detail,
      )
        ? 'unknown-gate'
        : 'invalid-args';
      return { status: 'error', class: cls, detail };
    }

    const normalized = await normalizeIssueRef(parsed.data.issue, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!normalized.ok) return normalized.error;

    const gateDef = GATES.get(parsed.data.gate);
    if (!gateDef) {
      return {
        status: 'error',
        class: 'unknown-gate',
        detail: `unknown gate "${parsed.data.gate}"`,
      };
    }

    const captured: string[] = [];
    const stderrLines: string[] = [];
    const advanceDeps: AdvanceCommandDeps = {
      gh: deps.gh ?? normalized.value.gh,
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.loadConfig != null ? { loadConfig: deps.loadConfig } : {}),
      ...(deps.env != null ? { env: deps.env } : {}),
      ...(deps.now != null ? { now: deps.now } : {}),
      stdout: (line: string) => captured.push(line),
      stderr: (line: string) => stderrLines.push(line),
    };

    const issueArg = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
    await runAdvance(issueArg, { gate: parsed.data.gate }, advanceDeps);

    const noop = captured.some((l) => l.startsWith('already advanced'));
    if (noop) {
      return {
        status: 'ok',
        data: {
          ref: normalized.value.ref,
          gate: gateDef.name,
          action: 'already-advanced',
          completedLabel: gateDef.completedLabel,
          noop: true,
        },
      };
    }

    const commentMatch = captured
      .map((l) => /\(comment: (https?:\/\/[^)]+)\)/.exec(l))
      .find((m) => m != null);
    const commentUrl = commentMatch ? commentMatch[1] : undefined;

    return {
      status: 'ok',
      data: {
        ref: normalized.value.ref,
        gate: gateDef.name,
        action: 'advanced',
        completedLabel: gateDef.completedLabel,
        ...(commentUrl ? { commentUrl } : {}),
      },
    };
  });
}
