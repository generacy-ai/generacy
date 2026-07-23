/**
 * Build the `@modelcontextprotocol/sdk` MCP server exposing the seven cockpit
 * tools over stdio. Tools call the same internal `run<Verb>()` functions the
 * CLI uses (spec § Design invariant #1).
 *
 * Each handler returns `ToolResult<T>` — either `{status:"ok", data}` or
 * `{status:"error", class, detail}`. That envelope is serialized as
 * `structuredContent` so callers can dispatch on `status` without parsing
 * text.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CommandRunner } from '@generacy-ai/cockpit';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from './errors.js';
import { cockpitStatus } from './tools/cockpit_status.js';
import { cockpitContext } from './tools/cockpit_context.js';
import { cockpitAdvance } from './tools/cockpit_advance.js';
import { cockpitResume } from './tools/cockpit_resume.js';
import { cockpitQueue } from './tools/cockpit_queue.js';
import { cockpitMerge } from './tools/cockpit_merge.js';
import { cockpitAwaitEvents } from './tools/cockpit_await_events.js';
import { cockpitScopeAdd } from './tools/cockpit_scope_add.js';
import { cockpitScopeRemove } from './tools/cockpit_scope_remove.js';
import { cockpitRelayClarifyAnswers } from './tools/cockpit_relay_clarify_answers.js';
import { cockpitClaim } from './tools/cockpit_claim.js';
import { cockpitRelease } from './tools/cockpit_release.js';
import { cockpitGateOpen } from './tools/cockpit_gate_open.js';
import { cockpitGateAck } from './tools/cockpit_gate_ack.js';
import {
  CockpitStatusInputSchema,
  CockpitContextInputSchema,
  CockpitAdvanceInputSchema,
  CockpitResumeInputSchema,
  CockpitQueueInputSchema,
  CockpitMergeInputSchema,
  CockpitScopeAddInputSchema,
  CockpitScopeRemoveInputSchema,
  CockpitRelayClarifyAnswersInputSchema,
  CockpitClaimInputSchema,
  CockpitReleaseInputSchema,
  CockpitGateOpenInputSchema,
  CockpitGateAckInputSchema,
  AwaitEventsInputSchema,
} from './schemas.js';

export interface BuildMcpServerDeps {
  runner?: CommandRunner;
  /**
   * #1022 — remote-gate tools only. Base URL of the in-cluster orchestrator.
   * Precedence: arg > `$ORCHESTRATOR_URL` > `http://127.0.0.1:3100` (resolved in
   * `gates/options.ts`, not here).
   */
  orchestratorUrl?: string;
  /** #1022 — per-request HTTP timeout in ms for remote-gate tools. Default 5000. */
  orchestratorTimeoutMs?: number;
  /** #1022 — test-only fetch override for remote-gate tools. Production leaves undefined. */
  fetchImpl?: typeof fetch;
}

function toCallToolResult<T>(result: ToolResult<T>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: result.status === 'error',
  };
}

export function buildMcpServer(deps: BuildMcpServerDeps = {}): McpServer {
  const server = new McpServer({
    name: 'cockpit',
    version: '1.0.0',
  });

  server.registerTool(
    'cockpit_status',
    {
      description:
        "Print a one-shot snapshot of every ref in the epic body's phases. Read-only.",
      inputSchema: CockpitStatusInputSchema,
    },
    async (args) => toCallToolResult(await cockpitStatus(args as never, deps)),
  );

  server.registerTool(
    'cockpit_context',
    {
      description: 'Classify the current waiting-for:* gate for one issue and emit its bundle.',
      inputSchema: CockpitContextInputSchema,
    },
    async (args) => toCallToolResult(await cockpitContext(args as never, deps)),
  );

  server.registerTool(
    'cockpit_advance',
    {
      description:
        'Manually flip waiting-for:<gate> → completed:<gate> on one issue. Posts an audit comment.',
      inputSchema: CockpitAdvanceInputSchema,
    },
    async (args) => toCallToolResult(await cockpitAdvance(args as never, deps)),
  );

  server.registerTool(
    'cockpit_resume',
    {
      description:
        'Re-arm a failed phase in place: clears failed:<phase>/agent:error, applies waiting-for/completed pair for the preceding gate.',
      inputSchema: CockpitResumeInputSchema,
    },
    async (args) => toCallToolResult(await cockpitResume(args as never, deps)),
  );

  server.registerTool(
    'cockpit_queue',
    {
      description:
        'Enqueue eligible refs under a phase heading to the cluster pipeline (unconfirmed — no interactive prompt).',
      inputSchema: CockpitQueueInputSchema,
    },
    async (args) => toCallToolResult(await cockpitQueue(args as never, deps)),
  );

  server.registerTool(
    'cockpit_merge',
    {
      description:
        'Merge a PR once its required checks are green. Never merges on red.',
      inputSchema: CockpitMergeInputSchema,
    },
    async (args) => toCallToolResult(await cockpitMerge(args as never, deps)),
  );

  server.registerTool(
    'cockpit_scope_add',
    {
      description:
        "Append a task-list ref to a scope (epic or tracking) issue's body. Concurrency-safe with bounded retry.",
      inputSchema: CockpitScopeAddInputSchema,
    },
    async (args) => toCallToolResult(await cockpitScopeAdd(args as never, deps)),
  );

  server.registerTool(
    'cockpit_scope_remove',
    {
      description:
        "Remove a task-list ref line from a scope issue's body. Concurrency-safe with bounded retry.",
      inputSchema: CockpitScopeRemoveInputSchema,
    },
    async (args) => toCallToolResult(await cockpitScopeRemove(args as never, deps)),
  );

  server.registerTool(
    'cockpit_relay_clarify_answers',
    {
      description:
        'Post a deterministic marker-stamped answer comment for a clarification batch and apply completed:clarification. Idempotent per batch.',
      inputSchema: CockpitRelayClarifyAnswersInputSchema,
    },
    async (args) =>
      toCallToolResult(await cockpitRelayClarifyAnswers(args as never, deps)),
  );

  server.registerTool(
    'cockpit_claim',
    {
      description:
        'Idempotent acquire-or-refresh-or-takeover of the active-driver claim on a scope. Called at arm time and per-wake by /cockpit:auto.',
      inputSchema: CockpitClaimInputSchema,
    },
    async (args) => toCallToolResult(await cockpitClaim(args as never, deps)),
  );

  server.registerTool(
    'cockpit_release',
    {
      description:
        'Explicit release of the active-driver claim. Idempotent — no-op success when caller is not the holder or when no claim exists.',
      inputSchema: CockpitReleaseInputSchema,
    },
    async (args) => toCallToolResult(await cockpitRelease(args as never, deps)),
  );

  server.registerTool(
    'cockpit_await_events',
    {
      description:
        'Long-poll for cockpit stream events (label changes, phase transitions, epic-complete). Returns a coalesced batch; caller re-arms with the returned cursor.',
      inputSchema: AwaitEventsInputSchema,
    },
    async (args) => toCallToolResult(await cockpitAwaitEvents(args as never, deps)),
  );

  // #1022 — Design-invariant-#1 exception (Q3 → A):
  //
  // The other 12 cockpit MCP tools wrap standalone `generacy cockpit <verb>`
  // CLI commands so an operator can drive them by hand. `cockpit_gate_open`
  // and `cockpit_gate_ack` intentionally do NOT ship a `generacy cockpit
  // gate-open|gate-ack` CLI twin: they are only meaningful inside an active
  // `/cockpit:auto` session (opening a gate outside that ledger is a bug, not
  // a feature). Mocked-orchestrator unit tests cover the same code paths a
  // CLI twin would exercise (see gates/__tests__/client.test.ts and the
  // parity-gate-*.test.ts suites). See spec.md § "Clarified decisions" and
  // research.md R8 for the full rationale.
  server.registerTool(
    'cockpit_gate_open',
    {
      description:
        "Open a remote gate on the orchestrator so it surfaces in the generacy.ai operator inbox. Thin HTTP client; cluster-not-cloud-activated and network failures collapse to class:'transport' for the local AskUserQuestion fallback.",
      inputSchema: CockpitGateOpenInputSchema,
    },
    async (args) => toCallToolResult(await cockpitGateOpen(args, deps)),
  );

  server.registerTool(
    'cockpit_gate_ack',
    {
      description:
        "Ack a previously-opened gate with a terminal outcome ('applied' | 'superseded' | 'failed'). Emits the frozen gate-outcome record over POST /cockpit/gates/:id/ack.",
      inputSchema: CockpitGateAckInputSchema,
    },
    async (args) => toCallToolResult(await cockpitGateAck(args, deps)),
  );

  return server;
}
