/**
 * Contract: InvokeIntent — new intent kind for Phase 5.
 *
 * This file documents the type contract, not executable code.
 * The actual implementation lives in:
 *   packages/generacy-plugin-claude-code/src/launch/types.ts
 */

// ─── Intent ─────────────────────────────────────────────────────────

/**
 * Intent for invoking Claude CLI with a raw command string.
 * Used by the root-level ClaudeCodeInvoker adapter.
 *
 * Produces argv: ['--print', '--dangerously-skip-permissions', command]
 */
export interface InvokeIntent {
  kind: 'invoke';
  /** Raw command string (e.g., "/speckit:specify https://github.com/...") */
  command: string;
  /** Whether to stream output (reserved for future use) */
  streaming?: boolean;
}

// ─── LaunchSpec output ──────────────────────────────────────────────

/**
 * What ClaudeCodeLaunchPlugin.buildLaunch() returns for an InvokeIntent:
 *
 * {
 *   command: 'claude',
 *   args: ['--print', '--dangerously-skip-permissions', intent.command],
 *   stdioProfile: 'default',
 * }
 */

// ─── Adapter translation ────────────────────────────────────────────

/**
 * InvocationConfig → LaunchRequest mapping:
 *
 * InvocationConfig.command          → InvokeIntent.command
 * InvocationConfig.streaming        → InvokeIntent.streaming
 * InvocationConfig.context.workingDirectory → LaunchRequest.cwd
 * InvocationConfig.context.environment + CLAUDE_MODE → LaunchRequest.env
 * InvocationConfig.timeout          → adapter-level setTimeout (not in LaunchRequest)
 *
 * LaunchHandle → InvocationResult mapping:
 *
 * handle.process.stdout data events → stdout string → combineOutput() → InvocationResult.output
 * handle.process.stderr data events → stderr string → combineOutput() → InvocationResult.output
 * handle.process.exitPromise        → InvocationResult.exitCode
 * parseToolCalls(output)            → InvocationResult.toolCalls
 * Date.now() - startTime            → InvocationResult.duration
 * exit code / timeout / error       → InvocationResult.success + InvocationResult.error
 */
