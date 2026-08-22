/**
 * US1 composed-loop integration suite (#1168). Drives the REAL `ReviewExecutor`
 * + `computeVerdict` under a real `PhaseLoop.executeLoop`, reaching the review
 * agent through the spawning `AgentLauncher` double → `scripted-review-cli.mjs`
 * fixture (a real `child_process.spawn`). The verdict is recomputed by
 * production code from the candidate the fixture writes — never steered by a
 * `readFindingsArtifact` stub (SC-002). Assertions target the engine-written
 * authoritative artifact (`review-findings-<sanitized>.json`), never the
 * candidate's claimed verdict.
 *
 * The harness `gateChecker.checkGates` returns `[]` (no cap gate), so a
 * `remediateTrigger` that always fires against a fixture that always yields
 * `changes-required` would loop forever. Every scenario that exercises the
 * remediate/off-sequence path therefore uses a FIRE-ONCE trigger.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReviewArtifact, readReviewArtifactSync } from '../review-artifact.js';
import type { ChildProcessHandle } from '../types.js';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';
import {
  createReviewCompositionHarness,
  type ReviewCompositionHarness,
} from './helpers/review-composition-harness.js';

const harnesses: ReviewCompositionHarness[] = [];

async function newHarness(): Promise<ReviewCompositionHarness> {
  const h = await createReviewCompositionHarness();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()!.cleanup();
  }
});

/**
 * A `remediateTrigger` that fires at most once, and only while the engine's
 * recomputed verdict is `changes-required`. Proves the loop acted on the
 * RECOMPUTED verdict (read from the authoritative artifact) while bounding the
 * loop so the composed suite terminates.
 */
function fireOnceOnChangesRequired(
  harness: ReviewCompositionHarness,
  counter: { fired: number },
): (context: unknown) => boolean {
  return () => {
    if (counter.fired >= 1) return false;
    const verdict = readReviewArtifactSync(harness.checkoutPath, harness.workflowId)?.verdict;
    if (verdict === 'changes-required') {
      counter.fired += 1;
      return true;
    }
    return false;
  };
}

describe('#1168 US1 — real ReviewExecutor composed under PhaseLoop', () => {
  it('T010: recomputes changes-required from an open critical finding despite a candidate claiming verdict:clean', async () => {
    const harness = await newHarness();
    // The fixture writes a candidate that LIES: top-level `verdict: clean`,
    // while carrying one open `critical` finding. The engine must ignore the
    // claim and recompute `changes-required` from the finding (#1155 / SC-001).
    const candidateJson = JSON.stringify({
      verdict: 'clean',
      findings: [
        {
          severity: 'critical',
          file: 'packages/orchestrator/src/foo.ts',
          line: 1,
          title: 'phantom-clean regression',
          detail: 'an open blocking finding the candidate falsely claims is clean',
          status: 'open',
        },
      ],
    });
    const agentLauncher = harness.makeSpawningLauncher({ mode: 'write', candidateJson });

    const counter = { fired: 0 };
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      extraDeps: { remediateTrigger: fireOnceOnChangesRequired(harness, counter) },
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    // SC-001: the ENGINE-authoritative artifact — not the candidate — is
    // changes-required. Read from the strict `review-findings-<sanitized>.json`.
    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).not.toBeNull();
    expect(artifact!.verdict).toBe('changes-required');

    // The loop ACTED on the recomputed verdict: the fire-once trigger read
    // `changes-required` off the artifact and drove the off-sequence remediate
    // pass (never the ready path).
    expect(counter.fired).toBe(1);
    const remediateStarts = (
      deps.labelManager.onPhaseStart as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => c[0] === 'remediate');
    expect(remediateStarts.length).toBe(1);
  });
});

interface CandidateFinding {
  severity: 'critical' | 'major' | 'minor';
  status: 'open' | 'resolved';
}

/** Build a candidate body carrying the given findings (fixed file/title/detail). */
function candidateWith(findings: CandidateFinding[]): string {
  return JSON.stringify({
    findings: findings.map((f, i) => ({
      severity: f.severity,
      file: `packages/orchestrator/src/foo${i}.ts`,
      line: i + 1,
      title: `finding-${i}`,
      detail: `detail for finding ${i}`,
      status: f.status,
    })),
  });
}

describe('#1168 US1 — severity-gating boundaries (T011, FR-003)', () => {
  // Mirrors data-model.md's truth table. Verdict flows through the real
  // ReviewExecutor + computeVerdict — never a direct computeVerdict call — so
  // this pins the composed engine path, not the pure function in isolation.
  const cases: {
    name: string;
    findings: CandidateFinding[];
    blockingSeverity: 'critical' | 'major' | 'minor';
    verdict: 'clean' | 'changes-required';
  }[] = [
    {
      name: 'all open:minor + major → clean',
      findings: [
        { severity: 'minor', status: 'open' },
        { severity: 'minor', status: 'open' },
      ],
      blockingSeverity: 'major',
      verdict: 'clean',
    },
    {
      name: 'one open:critical + major → changes-required',
      findings: [{ severity: 'critical', status: 'open' }],
      blockingSeverity: 'major',
      verdict: 'changes-required',
    },
    {
      name: 'one open:major + critical → clean',
      findings: [{ severity: 'major', status: 'open' }],
      blockingSeverity: 'critical',
      verdict: 'clean',
    },
    {
      name: 'one open:critical + critical → changes-required',
      findings: [{ severity: 'critical', status: 'open' }],
      blockingSeverity: 'critical',
      verdict: 'changes-required',
    },
    {
      name: 'one resolved:critical + critical → clean',
      findings: [{ severity: 'critical', status: 'resolved' }],
      blockingSeverity: 'critical',
      verdict: 'clean',
    },
  ];

  it.each(cases)('T011: $name', async ({ findings, blockingSeverity, verdict }) => {
    const harness = await newHarness();
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJson: candidateWith(findings),
    });

    // No remediateTrigger: neither verdict fires the off-sequence path, so the
    // loop runs implement → review → validate and terminates for both outcomes.
    const { context, config, deps, sequence } = harness.build({ agentLauncher, blockingSeverity });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).not.toBeNull();
    expect(artifact!.verdict).toBe(verdict);
  });
});

interface LifecycleFinding {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  title: string;
  status: 'open' | 'resolved';
}

/** Build a candidate body from explicit findings (stable file/title → stable ids). */
function lifecycleCandidate(findings: LifecycleFinding[]): string {
  return JSON.stringify({
    findings: findings.map((f, i) => ({
      severity: f.severity,
      file: f.file,
      line: i + 1,
      title: f.title,
      detail: `detail for ${f.title}`,
      status: f.status,
    })),
  });
}

describe('#1168 US1 — finding-status lifecycle across rounds (T012, FR-004)', () => {
  // Drives the off-sequence remediate → re-review loop with a fire-once trigger.
  // Round 1 yields `changes-required` (open blocking finding); the trigger reads
  // the RECOMPUTED verdict off the authoritative artifact and drives one
  // remediate pass; round 2's fixture-written candidate then feeds the engine
  // merge (`advanceArtifact`). Assertions target the merged authoritative
  // artifact — never a candidate claim.

  const BLOCKING_FILE = 'packages/orchestrator/src/foo.ts';

  it('T012: an open finding the agent marks resolved is carried over as resolved at round 2', async () => {
    const harness = await newHarness();

    // Round 1: one open critical finding → recomputed `changes-required`.
    // Round 2: the SAME file+title (⇒ same deterministic id) marked `resolved`.
    // The finding's file is in the delta, so the engine transitions the prior
    // `open` copy to `resolved` and recomputes `clean`.
    const round1 = lifecycleCandidate([
      { severity: 'critical', file: BLOCKING_FILE, title: 'blocking-finding-A', status: 'open' },
    ]);
    const round2 = lifecycleCandidate([
      { severity: 'critical', file: BLOCKING_FILE, title: 'blocking-finding-A', status: 'resolved' },
    ]);
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJsonByRound: { 1: round1, 2: round2 },
    });

    const counter = { fired: 0 };
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      extraDeps: { remediateTrigger: fireOnceOnChangesRequired(harness, counter) },
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).not.toBeNull();
    expect(artifact!.round).toBe(2);
    expect(artifact!.verdict).toBe('clean');

    const findingA = artifact!.findings.find((f) => f.title === 'blocking-finding-A');
    expect(findingA).toBeDefined();
    expect(findingA!.status).toBe('resolved');

    expect(counter.fired).toBe(1);
  });

  it('T012: a sub-blocking finding introduced at round 2 is dropped by the engine advisory filter', async () => {
    const harness = await newHarness();

    // blockingSeverity=major. Round 1: open critical → `changes-required`.
    // Round 2: finding A resolved + a NEW open MINOR finding. `filterNewFindings`
    // drops sub-blocking findings at round ≥ 2, so B never lands in the artifact
    // and the merged verdict is `clean`.
    const round1 = lifecycleCandidate([
      { severity: 'critical', file: BLOCKING_FILE, title: 'blocking-finding-A', status: 'open' },
    ]);
    const round2 = lifecycleCandidate([
      { severity: 'critical', file: BLOCKING_FILE, title: 'blocking-finding-A', status: 'resolved' },
      {
        severity: 'minor',
        file: 'packages/orchestrator/src/bar.ts',
        title: 'sub-blocking-finding-B',
        status: 'open',
      },
    ]);
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJsonByRound: { 1: round1, 2: round2 },
    });

    const counter = { fired: 0 };
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      blockingSeverity: 'major',
      extraDeps: { remediateTrigger: fireOnceOnChangesRequired(harness, counter) },
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).not.toBeNull();
    expect(artifact!.round).toBe(2);
    expect(artifact!.verdict).toBe('clean');

    const titles = artifact!.findings.map((f) => f.title);
    expect(titles).toContain('blocking-finding-A');
    expect(titles).not.toContain('sub-blocking-finding-B');

    expect(counter.fired).toBe(1);
  });
});

/**
 * A `ChildProcessHandle` that never exits on its own — only a `kill(signal)`
 * resolves its `exitPromise` (with 143, mirroring SIGTERM). Drives the review
 * executor's phase-timeout → SIGTERM path (`review-executor.ts:247-262`).
 */
function makeNeverExitingProcess(): ChildProcessHandle & { kill: ReturnType<typeof vi.fn> } {
  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  return {
    stdin: null,
    stdout: new EventEmitter() as unknown as NodeJS.ReadableStream,
    stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
    pid: 4242,
    kill: vi.fn(() => {
      resolveExit(143);
      return true;
    }),
    exitPromise,
  };
}

/**
 * A `ChildProcessHandle` that exits immediately with a non-zero code — the CLI
 * ran to completion but failed (`exitCode !== 0` at `review-executor.ts:300`).
 */
function makeImmediateExitProcess(exitCode: number): ChildProcessHandle {
  return {
    stdin: null,
    stdout: new EventEmitter() as unknown as NodeJS.ReadableStream,
    stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
    pid: 4243,
    kill: vi.fn(() => true),
    exitPromise: Promise.resolve(exitCode),
  };
}

/** Wrap a fixed `ChildProcessHandle` as an `AgentLauncher` double. */
function launcherFor(process: ChildProcessHandle): AgentLauncher {
  return {
    launch: vi.fn(async () => ({
      process,
      outputParser: { processChunk: () => undefined, flush: () => undefined },
      metadata: { pluginId: 'test-spawning-double', intentKind: 'review' },
    })),
  } as unknown as AgentLauncher;
}

describe('#1168 US1 — executor failure paths persist nothing (T013, FR-005/SC-004)', () => {
  // Each scenario yields a DISTINCT failure mode, but the shared invariant is
  // that the engine-authoritative artifact is never written: a failed review
  // round advances neither `round` nor the verdict, and the loop terminates
  // `completed: false` at `lastPhase: 'review'` via the generic escalation path
  // (phase-loop.ts:1165-1181) — never the ready/validate path.

  it('T013(a): a withheld sidecar (spawn exits 0, no candidate) is a no-verdict round — persists nothing', async () => {
    const harness = await newHarness();
    // FIXTURE_MODE=withhold: the real spawn writes NO candidate and exits 0.
    // `readCandidateFindings` returns null → `findings === null` gate → the
    // executor returns success:false, exitCode:0 and writes no artifact.
    const agentLauncher = harness.makeSpawningLauncher({ mode: 'withhold' });
    const { context, config, deps, sequence } = harness.build({ agentLauncher });

    const loopResult = await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    expect(loopResult.completed).toBe(false);
    expect(loopResult.lastPhase).toBe('review');

    // No authoritative artifact was ever written (never `clean`, never any verdict).
    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).toBeNull();
  });

  it('T013(b): a CLI that never exits is SIGTERM-killed at the phase timeout — success:false, persists nothing', async () => {
    const harness = await newHarness();
    const child = makeNeverExitingProcess();
    const agentLauncher = launcherFor(child);
    // Hand-built sub-60s timeouts (the harness bypasses Zod `.min(60_000)`): the
    // timer fires almost immediately, kill('SIGTERM') resolves exitPromise → 143.
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      phaseTimeoutMs: 20,
      shutdownGracePeriodMs: 10,
    });

    const loopResult = await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(loopResult.completed).toBe(false);
    expect(loopResult.lastPhase).toBe('review');

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).toBeNull();
  });

  it('T013(c): a CLI that exits non-zero fails the phase gate — persists nothing', async () => {
    const harness = await newHarness();
    const agentLauncher = launcherFor(makeImmediateExitProcess(2));
    const { context, config, deps, sequence } = harness.build({ agentLauncher });

    const loopResult = await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    expect(loopResult.completed).toBe(false);
    expect(loopResult.lastPhase).toBe('review');

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).toBeNull();
  });
});
