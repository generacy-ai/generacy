// #1161 T023 (US4) — docs-vs-code default (SC-007) + single-source-of-round (SC-006).
//
// SC-007: the per-workflow default `blockingSeverity` documented in
//   `docs/docs/reference/review-artifacts.md` must equal what the code resolves.
//   `defaultBlockingSeverity` is private, so we assert through the exported
//   `resolveWorkflowOverrides` wrapper (no new export introduced).
//
// SC-006: one review has exactly one round counter. The executor derives the
//   round from the prior artifact (`(prior?.round ?? 0) + 1`) and the delta
//   derives it identically (`artifact.round + 1`); the agent-claimed candidate
//   round is IGNORED. We prove no counter disagrees by driving the live
//   executor and asserting (a) every persisted finding's `round` equals the
//   artifact's top-level `round`, and (b) a second run over a seeded round-1
//   artifact persists exactly `round === 2`.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, WorkerContext } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { resolveWorkflowOverrides } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ReviewExecutor } from '../review-executor.js';
import {
  getReviewArtifactPath,
  getReviewCandidatePath,
  readReviewArtifact,
} from '../review-artifact.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

const baseConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'echo validate',
  gates: {},
} as WorkerConfig;

const DOCS_PATH = fileURLToPath(
  new URL('../../../../../docs/docs/reference/review-artifacts.md', import.meta.url),
);

describe('#1161 docs-vs-code default blockingSeverity (SC-007)', () => {
  it('resolveWorkflowOverrides agrees with the documented per-workflow defaults', async () => {
    const docs = await readFile(DOCS_PATH, 'utf-8');
    // Whitespace-tolerant: the prose wraps across lines.
    const featureMatch = docs.match(/`(critical|major|minor)`\s+for\s+`speckit-feature`/);
    const otherMatch = docs.match(
      /`(critical|major|minor)`\s+for\s+every\s+other\s+workflow/,
    );

    expect(featureMatch, 'docs must document the speckit-feature default').not.toBeNull();
    expect(otherMatch, 'docs must document the every-other-workflow default').not.toBeNull();

    const documentedFeature = featureMatch![1];
    const documentedOther = otherMatch![1];

    // Sanity: this is the reconciled #1161 D3 decision.
    expect(documentedFeature).toBe('major');
    expect(documentedOther).toBe('critical');

    expect(resolveWorkflowOverrides(baseConfig, null, 'speckit-feature').review.blockingSeverity).toBe(
      documentedFeature,
    );
    expect(resolveWorkflowOverrides(baseConfig, null, 'speckit-bugfix').review.blockingSeverity).toBe(
      documentedOther,
    );
    expect(resolveWorkflowOverrides(baseConfig, null, 'speckit-epic').review.blockingSeverity).toBe(
      documentedOther,
    );
  });
});

describe('#1161 single-source-of-round (SC-006)', () => {
  let checkoutPath: string;
  const workflowId = 'owner/repo#77';

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'round-src-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  function makeContext(github: GitHubClient): WorkerContext {
    const item: QueueItem = {
      owner: 'owner',
      repo: 'repo',
      issueNumber: 77,
      workflowName: 'speckit-feature',
      command: 'review',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: { phase: 'review' },
    };
    return {
      workerId: 'w1',
      jobId: 'j1',
      item,
      startPhase: 'review',
      github,
      logger,
      signal: new AbortController().signal,
      checkoutPath,
      issueUrl: 'https://github.com/owner/repo/issues/77',
      description: 'test',
    } as WorkerContext;
  }

  function makeGithub(): GitHubClient {
    return {
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      commitExistsInCheckout: vi.fn().mockResolvedValue(false),
      getFilesChangedBetween: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;
  }

  function makeProcess(exitCode = 0): ChildProcessHandle {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let resolveExit: (code: number | null) => void;
    const exitPromise = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const handle: ChildProcessHandle = {
      stdin: null,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      pid: 4343,
      kill: vi.fn((sig?: string) => {
        if (sig === 'SIGTERM' || sig === 'SIGKILL') resolveExit(exitCode);
        return true;
      }),
      exitPromise,
    };
    setTimeout(() => resolveExit(exitCode), 5);
    return handle;
  }

  /**
   * Launcher whose agent candidate CLAIMS `round: 99` — a value the engine must
   * ignore. The single source of round is the prior artifact, not the sidecar.
   */
  function makeLauncher(): AgentLauncher {
    const launch = vi.fn(async () => {
      const filePath = getReviewCandidatePath(checkoutPath, workflowId);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          verdict: 'changes-required',
          round: 99, // agent-claimed — must be ignored
          findings: [
            {
              severity: 'major',
              file: 'src/a.ts',
              title: 'Unhandled promise rejection',
              detail: 'Promise is not awaited; failure is swallowed.',
            },
          ],
        }),
        'utf-8',
      );
      return {
        process: makeProcess(0),
        outputParser: { processChunk: () => undefined, flush: () => undefined },
        metadata: { pluginId: 'claude-code', intentKind: 'review' },
      };
    });
    return { launch } as unknown as AgentLauncher;
  }

  it('round 1: every persisted finding round equals the artifact round (and ignores the agent claim)', async () => {
    const executor = new ReviewExecutor({
      agentLauncher: makeLauncher(),
      config: baseConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(makeGithub()));

    const persisted = await readReviewArtifact(checkoutPath, workflowId);
    expect(persisted).not.toBeNull();
    expect(persisted!.round).toBe(1);
    for (const f of persisted!.findings) {
      expect(f.round).toBe(persisted!.round);
    }
  });

  it('round 2: increments by exactly 1 from the prior artifact, not from the agent claim', async () => {
    // Seed a round-1 artifact so this run is the second review round.
    const artifactPath = getReviewArtifactPath(checkoutPath, workflowId);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      JSON.stringify({
        findings: [
          {
            id: 'seed-1',
            severity: 'major',
            file: 'src/a.ts',
            title: 'Unhandled promise rejection',
            detail: 'Promise is not awaited; failure is swallowed.',
            round: 1,
            status: 'open',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'cafe1234',
        remediationCount: 0,
        markedReadyByEngine: false,
      }),
      'utf-8',
    );

    const executor = new ReviewExecutor({
      agentLauncher: makeLauncher(),
      config: baseConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(makeGithub()));

    const persisted = await readReviewArtifact(checkoutPath, workflowId);
    expect(persisted).not.toBeNull();
    // prior.round (1) + 1 — NOT the agent-claimed 99, NOT a private counter.
    expect(persisted!.round).toBe(2);
  });
});
