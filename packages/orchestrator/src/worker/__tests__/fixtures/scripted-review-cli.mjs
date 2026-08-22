#!/usr/bin/env node
// @ts-nocheck
/**
 * Scripted agent-CLI fixture (#1168, FR-001 / SC-002) — the first real-spawnable
 * fixture in the repo. Stands in for the review agent's CLI so the composed
 * integration suite can exercise the REAL `ReviewExecutor` + `computeVerdict`
 * end-to-end via `child_process.spawn(process.execPath, [__filename], { cwd, env })`
 * (see `helpers/spawning-agent-launcher.ts`). It is NOT a verdict-steering stub:
 * it only writes (or withholds) the candidate sidecar the engine then reads and
 * recomputes the verdict from.
 *
 * Scoped to the write / withhold (missing-sidecar) scenarios only (Q2→A). The
 * timeout and non-zero-exit paths use a mocked hanging `ChildProcessHandle`, not
 * this fixture.
 *
 * Inputs (env vars set on the spawn):
 *   FIXTURE_CHECKOUT_PATH  absolute checkout root; candidate written under `.generacy/`.
 *   FIXTURE_WORKFLOW_ID    `${owner}/${repo}#${issueNumber}` — sanitized the same
 *                          way the engine derives the candidate path.
 *   FIXTURE_MODE           `write` | `withhold`.
 *   FIXTURE_CANDIDATE_JSON (mode `write`) exact candidate JSON body to write verbatim.
 *   FIXTURE_CANDIDATE_JSON_BY_ROUND (mode `write`, optional) a JSON object mapping
 *                          `"<round>" → candidateJsonString`. When present, the
 *                          fixture selects the candidate for the round it is about
 *                          to drive: it reads the engine's authoritative artifact
 *                          (`review-findings-<sanitized>.json`), takes its `round`
 *                          (0 when absent), and writes the candidate keyed at
 *                          `round + 1`. This lets one launcher/fixture drive
 *                          distinct round-1 vs round-2 candidates across the
 *                          off-sequence remediate → re-review loop (FR-004).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const checkoutPath = process.env.FIXTURE_CHECKOUT_PATH;
const workflowId = process.env.FIXTURE_WORKFLOW_ID;
const mode = process.env.FIXTURE_MODE;
const candidateJson = process.env.FIXTURE_CANDIDATE_JSON;
const candidateJsonByRound = process.env.FIXTURE_CANDIDATE_JSON_BY_ROUND;

if (!checkoutPath || !workflowId) {
  // Missing wiring is a harness bug, not a scenario — fail loudly.
  process.exit(2);
}

if (mode === 'withhold') {
  // Write nothing: exit 0 with no candidate → missing-sidecar failure path.
  process.exit(0);
}

if (mode === 'write') {
  // Derive the candidate path the same way `getReviewCandidatePath` does:
  // sanitize `[^a-zA-Z0-9_-] → _`, join `.generacy/review-candidate-<sanitized>.json`.
  const safeId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(checkoutPath, '.generacy');
  const candidatePath = path.join(dir, `review-candidate-${safeId}.json`);

  let body = candidateJson ?? '';

  if (candidateJsonByRound) {
    // Determine the round this spawn is driving from the engine's authoritative
    // artifact: `round + 1` (0 when the file is absent → round 1).
    const artifactPath = path.join(dir, `review-findings-${safeId}.json`);
    let priorRound = 0;
    try {
      const parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      if (typeof parsed.round === 'number') priorRound = parsed.round;
    } catch {
      // No prior artifact (or unreadable) → this is round 1.
    }
    const nextRound = priorRound + 1;
    const byRound = JSON.parse(candidateJsonByRound);
    body = byRound[String(nextRound)] ?? '';
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(candidatePath, body, 'utf-8');
  process.exit(0);
}

// Unknown mode — harness bug.
process.exit(2);
