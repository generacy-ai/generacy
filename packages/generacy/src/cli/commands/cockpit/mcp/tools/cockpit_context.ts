/**
 * `cockpit_context` MCP tool handler.
 *
 * Wraps `runContext` — the internal function already returns the bundle
 * object directly (in addition to writing the JSON line to stdout). We
 * capture stdout to keep it off the MCP transport but use the return value
 * as `data`.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runContext, type ContextCommandDeps, type ContextBundle } from '../../context.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitContextInputSchema,
  type IssueRefInput,
} from '../schemas.js';

export interface CockpitContextInput {
  issue: IssueRefInput;
}

export interface CockpitContextDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
}

export function cockpitContext(
  input: CockpitContextInput,
  deps: CockpitContextDeps = {},
): Promise<ToolResult<ContextBundle>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitContextInputSchema.safeParse(input);
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
    const contextDeps: ContextCommandDeps = {
      gh: deps.gh ?? normalized.value.gh,
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      stdout: (line: string) => captured.push(line),
      stderr: (line: string) => stderrLines.push(line),
    };

    const issueArg = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
    const bundle = await runContext(issueArg, contextDeps);
    return { status: 'ok', data: bundle };
  });
}
