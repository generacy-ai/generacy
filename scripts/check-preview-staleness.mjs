#!/usr/bin/env node
// Refuses to publish if the current `origin/develop` HEAD is a strict
// ancestor of the SHA currently published under `@generacy-ai/generacy@preview`
// (per D7: that package is the anchor — always published, never private).
//
// Exit semantics (per contracts/workflow-inputs.md §"Staleness check contract"):
//   exit 0 — safe to publish (baseline missing, equal-SHA republish, or fresh)
//   exit 1 — refused (candidate is a strict ancestor of current preview)
//
// First-publish / registry-wipe / new-package: fail open (D3).

import { execSync } from 'node:child_process';

const ANCHOR = '@generacy-ai/generacy';

const candidateSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
  console.error(`ERROR: git rev-parse HEAD did not yield a 40-char SHA: ${candidateSha}`);
  process.exit(1);
}

let currentPreviewSha = '';
try {
  currentPreviewSha = execSync(`npm view ${ANCHOR}@preview gitHead`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch {
  // npm view exits non-zero when the dist-tag does not exist; D3 fail-open.
  currentPreviewSha = '';
}

if (!currentPreviewSha || !/^[0-9a-f]{40}$/.test(currentPreviewSha)) {
  console.log(`No baseline gitHead for ${ANCHOR}@preview — publishing unconditionally`);
  process.exit(0);
}

if (candidateSha === currentPreviewSha) {
  console.log(`Candidate ${candidateSha} equals current preview ${currentPreviewSha} — allowed (republish)`);
  process.exit(0);
}

let isAncestor = false;
try {
  execSync(`git merge-base --is-ancestor ${candidateSha} ${currentPreviewSha}`, {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  isAncestor = true;
} catch {
  isAncestor = false;
}

if (isAncestor) {
  console.error(`STALE: candidate ${candidateSha} is an ancestor of current preview ${currentPreviewSha}`);
  console.error(`Refusing to publish. Set force_rollback=true to override (workflow_dispatch only).`);
  process.exit(1);
}

console.log(`Candidate ${candidateSha} is not an ancestor of current preview ${currentPreviewSha} — fresh, publishing`);
process.exit(0);
