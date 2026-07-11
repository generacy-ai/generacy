/**
 * FR-002 regression coverage — LabelManager memoized ensure-pass.
 *
 * Asserts:
 * (a) `ensureRepoLabelsExist` runs at most once per `(owner, repo)` across
 *     concurrent callers — `listLabels` called exactly once.
 * (b) Missing labels from `WORKFLOW_LABELS` are created on first call.
 * (c) Per-label `createLabel` failures are logged at `warn` and do NOT abort
 *     the ensure pass or the outer label operation.
 * (d) Subsequent calls return early with no network activity.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import { LabelManager } from '../label-manager.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function makeGithub() {
  return {
    getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
  };
}

function createLabelManager(github: ReturnType<typeof makeGithub>, opts?: { owner?: string; repo?: string }): LabelManager {
  return new LabelManager(
    github as unknown as GitHubClient,
    opts?.owner ?? 'test-owner',
    opts?.repo ?? 'test-repo',
    42,
    mockLogger as unknown as Logger,
  );
}

describe('LabelManager.ensureRepoLabelsExist (FR-002)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
    LabelManager.resetEnsureCacheForTests();
  });

  it('runs listLabels exactly once across concurrent callers on the same repo', async () => {
    const github = makeGithub();
    // Slow listLabels so a second caller enters ensureRepoLabelsExist before
    // the first resolves — this is the exact case ensureInFlight guards against.
    let resolveList: (v: unknown) => void = () => {};
    github.listLabels.mockImplementationOnce(
      () => new Promise((r) => { resolveList = r; }),
    );

    const lm1 = createLabelManager(github);
    const lm2 = createLabelManager(github);

    // Both fire concurrently
    const p1 = lm1.onPhaseComplete('plan');
    const p2 = lm2.onPhaseComplete('plan');

    // Allow microtasks to schedule
    await new Promise((r) => setImmediate(r));

    // Let ensure-pass resolve
    resolveList([]);
    await Promise.all([p1, p2]);

    expect(github.listLabels).toHaveBeenCalledTimes(1);
  });

  it('creates every workflow label missing from the repo', async () => {
    const github = makeGithub();
    // Repo has none of the workflow labels
    github.listLabels.mockResolvedValue([]);

    const lm = createLabelManager(github);
    await lm.onPhaseComplete('plan');

    // Every WORKFLOW_LABELS entry should be created
    expect(github.createLabel).toHaveBeenCalledTimes(WORKFLOW_LABELS.length);
    // Spot-check the newly added one (FR-001). #898 T006 updated the
    // description to reference the self-describing pause comment; test
    // asserts current copy verbatim.
    expect(github.createLabel).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      'waiting-for:merge-conflicts',
      'FBCA04',
      'Base-merge conflict. See stage comment for the manual remedy.',
    );
  });

  it('does not abort ensure-pass on per-label create failure (race path)', async () => {
    const github = makeGithub();
    github.listLabels.mockResolvedValue([]);
    // First createLabel throws (simulates concurrent create-race with sibling worker)
    github.createLabel
      .mockRejectedValueOnce(new Error('label already exists'))
      .mockResolvedValue(undefined);

    const lm = createLabelManager(github);
    await expect(lm.onPhaseComplete('plan')).resolves.toBeUndefined();

    // All WORKFLOW_LABELS should still have been attempted
    expect(github.createLabel).toHaveBeenCalledTimes(WORKFLOW_LABELS.length);
    // #916 FR-007: race path is debug-level, not warn — healthy multi-worker
    // startup races on every boot, so warn+ would train operators to ignore warns.
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: expect.any(String),
        err: expect.stringContaining('already exists'),
      }),
      expect.stringContaining('Workflow label already exists (race)'),
    );
    // The outer addLabels must still succeed
    expect(github.addLabels).toHaveBeenCalled();
    // #916 FR-007: race still populates the ensured-repos cache and does NOT
    // write a lineage entry.
    expect(
      (LabelManager as unknown as {
        ensuredRepos: Set<string>;
      }).ensuredRepos.has('test-owner/test-repo'),
    ).toBe(true);
    const lineage = (LabelManager as unknown as {
      provisioningFailures: Map<string, Map<string, unknown>>;
    }).provisioningFailures.get('test-owner/test-repo');
    expect(lineage === undefined || lineage.size === 0).toBe(true);
  });

  it('returns early on repeat calls (no listLabels or createLabel on second use)', async () => {
    const github = makeGithub();
    github.listLabels.mockResolvedValue([]);

    const lm = createLabelManager(github);
    await lm.onPhaseComplete('plan');

    github.listLabels.mockClear();
    github.createLabel.mockClear();

    // Second call in the same process — must be a memoized no-op
    await lm.onPhaseComplete('specify');

    expect(github.listLabels).not.toHaveBeenCalled();
    expect(github.createLabel).not.toHaveBeenCalled();
  });

  it('does not memoize across (owner, repo) pairs', async () => {
    const gh1 = makeGithub();
    const gh2 = makeGithub();

    const lm1 = createLabelManager(gh1, { owner: 'org-a', repo: 'r1' });
    const lm2 = createLabelManager(gh2, { owner: 'org-b', repo: 'r2' });

    await lm1.onPhaseComplete('plan');
    await lm2.onPhaseComplete('plan');

    expect(gh1.listLabels).toHaveBeenCalledTimes(1);
    expect(gh2.listLabels).toHaveBeenCalledTimes(1);
  });
});

/**
 * #916 FR-006 regression: classified provisioning failures on the ensure-pass.
 *
 * Asserts the anti-swallowing contract: a 422 that pre-#916 was mislabeled as
 * "may already exist" now emits an error-level log naming the actual cause,
 * writes a lineage entry, and leaves `ensuredRepos` unmarked so a subsequent
 * caller retries.
 */
describe('classifies provisioning failures (#916 FR-006)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
    LabelManager.resetEnsureCacheForTests();
  });

  it('logs error, writes lineage, and leaves ensuredRepos unmarked on 422', async () => {
    const github = makeGithub();
    github.listLabels.mockResolvedValue([]);
    github.createLabel.mockImplementation(async (_owner, _repo, name: string) => {
      if (name.startsWith('blocked:stuck-')) {
        throw new Error(
          `Failed to create label ${name}: HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)`,
        );
      }
    });

    const lm = createLabelManager(github);
    await lm.onPhaseComplete('plan');

    // (a) three error-level entries, one per blocked:stuck-* label, naming
    // the actual cause via structured fields.
    const stuckErrorCalls = mockLogger.error.mock.calls.filter(
      ([fields, msg]) =>
        typeof msg === 'string' &&
        msg === 'Failed to create workflow label (provisioning error)' &&
        (fields as Record<string, unknown>).statusCode === 422 &&
        typeof (fields as Record<string, unknown>).cause === 'string' &&
        ((fields as Record<string, unknown>).cause as string).includes('description is too long'),
    );
    expect(stuckErrorCalls).toHaveLength(3);

    // (b) The lying "may already exist" line is never emitted.
    const misleadingWarn = mockLogger.warn.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('may already exist'),
    );
    expect(misleadingWarn).toBeUndefined();

    // (c) The outer addLabels still runs — the ensure-pass never throws.
    expect(github.addLabels).toHaveBeenCalled();

    // (d) The cache stays unmarked so the next non-concurrent caller retries.
    expect(
      (LabelManager as unknown as { ensuredRepos: Set<string> }).ensuredRepos.has(
        'test-owner/test-repo',
      ),
    ).toBe(false);

    // (e) Lineage map has one entry per failed label.
    const lineage = (LabelManager as unknown as {
      provisioningFailures: Map<string, Map<string, unknown>>;
    }).provisioningFailures.get('test-owner/test-repo');
    expect(lineage?.size).toBe(3);

    // (f) A subsequent onPhaseComplete on the same manager re-runs the pass.
    github.listLabels.mockClear();
    github.createLabel.mockClear();
    await lm.onPhaseComplete('specify');
    expect(github.listLabels).toHaveBeenCalled();
    expect(github.createLabel).toHaveBeenCalled();
  });
});
