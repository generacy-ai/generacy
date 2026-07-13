/**
 * `cockpit_status` MCP tool handler.
 *
 * Wraps `runStatus({json: true})` with an in-memory stdout sink; parses the
 * single-line JSON envelope the CLI already emits and returns it verbatim
 * as `data`. No stdout ever reaches the MCP transport (which uses stdout
 * for JSON-RPC).
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runStatus, type StatusDeps } from '../../status.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitStatusInputSchema,
  type EpicRefInput,
} from '../schemas.js';

export interface CockpitStatusInput {
  epic: EpicRefInput;
}

export type CockpitStatusData = unknown;

export interface CockpitStatusDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
}

export function cockpitStatus(
  input: CockpitStatusInput,
  deps: CockpitStatusDeps = {},
): Promise<ToolResult<CockpitStatusData>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitStatusInputSchema.safeParse(input);
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
    const statusDeps: StatusDeps = {
      gh: deps.gh ?? normalized.value.gh,
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      stdout: (line: string) => captured.push(line),
      stderr: (line: string) => stderrLines.push(line),
    };

    const epicArg = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
    const code = await runStatus(epicArg, { json: true }, statusDeps);

    if (code !== 0) {
      const detail = stderrLines.join('\n') || `runStatus exited ${code}`;
      const cls = code === 2 ? 'invalid-args' : 'transport';
      return { status: 'error', class: cls, detail };
    }

    const line = captured.find((l) => l.trim().length > 0);
    if (line == null) {
      return {
        status: 'error',
        class: 'internal',
        detail: 'runStatus produced no JSON envelope',
      };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      return {
        status: 'error',
        class: 'internal',
        detail: `runStatus JSON envelope parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { status: 'ok', data: parsedJson };
  });
}
