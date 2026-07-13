/**
 * `cockpit_resume` MCP tool handler.
 *
 * Wraps `runResume`. On happy-path, parses the "resumed ... added=[...] removed=[...]"
 * stdout line to recover the label mutation set for structured output.
 *
 * Non-failed issue no-op (resume.ts:189-193): CLI prints "issue ... is not in
 * a failed state" and exits 0. Represent as
 * `{status: "ok", data: {action: "no-op", targetPhase: null, precedingGate: null,
 * labelsAdded: [], labelsRemoved: []}}`.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runResume, type ResumeCommandDeps } from '../../resume.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitResumeInputSchema, type IssueRefInput } from '../schemas.js';

export interface CockpitResumeInput {
  issue: IssueRefInput;
}

export interface CockpitResumeData {
  ref: { owner: string; repo: string; number: number; nwo: string };
  action: 'resumed' | 'no-op';
  targetPhase: string | null;
  precedingGate: string | null;
  labelsAdded: string[];
  labelsRemoved: string[];
}

export interface CockpitResumeDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: ResumeCommandDeps['loadConfig'];
}

const RESUMED_LINE =
  /^resumed .* re-armed phase=([^ ]+) via preceding-gate=([^;]+); added=\[([^\]]*)\] removed=\[([^\]]*)\]/;

export function cockpitResume(
  input: CockpitResumeInput,
  deps: CockpitResumeDeps = {},
): Promise<ToolResult<CockpitResumeData>> {
  return wrapToolBoundary<CockpitResumeData>(async () => {
    const parsed = CockpitResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const normalized = await normalizeIssueRef(parsed.data.issue, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!normalized.ok) return normalized.error;

    const captured: string[] = [];
    const stderrLines: string[] = [];
    const resumeDeps: ResumeCommandDeps = {
      gh: deps.gh ?? normalized.value.gh,
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.loadConfig != null ? { loadConfig: deps.loadConfig } : {}),
      stdout: (line: string) => captured.push(line),
      stderr: (line: string) => stderrLines.push(line),
    };

    const issueArg = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
    await runResume(issueArg, {}, resumeDeps);

    const noop = captured.some((l) => l.includes('is not in a failed state'));
    if (noop) {
      return {
        status: 'ok',
        data: {
          ref: normalized.value.ref,
          action: 'no-op',
          targetPhase: null,
          precedingGate: null,
          labelsAdded: [],
          labelsRemoved: [],
        },
      };
    }

    const resumedLine = captured.find((l) => l.startsWith('resumed '));
    if (resumedLine != null) {
      const m = RESUMED_LINE.exec(resumedLine);
      if (m) {
        const [, phase, gate, added, removed] = m;
        return {
          status: 'ok',
          data: {
            ref: normalized.value.ref,
            action: 'resumed',
            targetPhase: phase!,
            precedingGate: gate!,
            labelsAdded: added!.split(',').filter((s) => s.length > 0),
            labelsRemoved: removed!.split(',').filter((s) => s.length > 0),
          },
        };
      }
    }

    return {
      status: 'ok',
      data: {
        ref: normalized.value.ref,
        action: 'resumed',
        targetPhase: '',
        precedingGate: '',
        labelsAdded: [],
        labelsRemoved: [],
      },
    };
  });
}
