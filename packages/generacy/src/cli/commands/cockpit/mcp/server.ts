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
import {
  CockpitStatusInputSchema,
  CockpitContextInputSchema,
  CockpitAdvanceInputSchema,
  CockpitResumeInputSchema,
  CockpitQueueInputSchema,
  CockpitMergeInputSchema,
  CockpitScopeAddInputSchema,
  CockpitScopeRemoveInputSchema,
  AwaitEventsInputSchema,
} from './schemas.js';

export interface BuildMcpServerDeps {
  runner?: CommandRunner;
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
    'cockpit_await_events',
    {
      description:
        'Long-poll for cockpit stream events (label changes, phase transitions, epic-complete). Returns a coalesced batch; caller re-arms with the returned cursor.',
      inputSchema: AwaitEventsInputSchema,
    },
    async (args) => toCallToolResult(await cockpitAwaitEvents(args as never, deps)),
  );

  return server;
}
