import { describe, it, expect, vi } from 'vitest';
import { runCockpitMcp } from '../index.js';

describe('cockpit mcp: role-refusal', () => {
  it('refuses to start when GENERACY_CLUSTER_ROLE=worker (exit non-zero, stderr message)', async () => {
    const stderrLines: string[] = [];
    const exitSpy = vi.fn((_code: number) => {
      throw new Error('__EXIT__');
    });
    let exitCode = -1;
    try {
      await runCockpitMcp({
        env: { GENERACY_CLUSTER_ROLE: 'worker' },
        stderr: (line: string) => stderrLines.push(line),
        exit: (code: number) => {
          exitCode = code;
          exitSpy(code);
          return undefined as never;
        },
      });
    } catch (err) {
      expect((err as Error).message).toBe('__EXIT__');
    }
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBe(-1);
    const joined = stderrLines.join('\n');
    expect(joined).toContain('GENERACY_CLUSTER_ROLE=worker');
    expect(joined).toContain('refusing');
  });

  it('proceeds when GENERACY_CLUSTER_ROLE=orchestrator (no exit)', async () => {
    const stderrLines: string[] = [];
    const exitSpy = vi.fn();
    const fakeTransport = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
    };
    // McpServer.connect calls transport.start; ensure our fake resolves.
    await runCockpitMcp({
      env: { GENERACY_CLUSTER_ROLE: 'orchestrator' },
      stderr: (line: string) => stderrLines.push(line),
      exit: (code: number) => {
        exitSpy(code);
        return undefined as never;
      },
      makeTransport: () => fakeTransport,
    });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fakeTransport.start).toHaveBeenCalled();
  });
});
