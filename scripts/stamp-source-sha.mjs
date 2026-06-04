#!/usr/bin/env node
// Stamps every published package.json with the source commit SHA:
//   - appends `-<sha7>` to `version` if not already present (idempotent)
//   - writes the full 40-char SHA to `gitHead` (npm conventional field)
//   - writes the full 40-char SHA to `generacy.sourceSha` (tooling-friendly
//     namespace), preserving other `generacy.*` keys
//
// Runs AFTER `pnpm changeset version --snapshot preview` (which rewrites
// `version`) and BEFORE `verify-pack-no-workspace-deps.js` + `pnpm publish`.
// Filters out `private: true` packages and entries in
// `.changeset/config.json#ignore`.

import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`ERROR: git rev-parse HEAD did not yield a 40-char SHA: ${sha}`);
  process.exit(1);
}
const short = sha.slice(0, 7);

const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));
const ignore = new Set(config.ignore || []);

let stamped = 0;
for (const dir of readdirSync('packages')) {
  const pkgPath = join('packages', dir, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.private || !pkg.name || ignore.has(pkg.name)) continue;

  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    console.error(`ERROR: ${pkg.name} has no version field`);
    process.exit(1);
  }
  if (!pkg.version.endsWith(`-${short}`)) {
    pkg.version = `${pkg.version}-${short}`;
  }
  pkg.gitHead = sha;
  pkg.generacy = { ...(pkg.generacy ?? {}), sourceSha: sha };

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`stamped ${pkg.name} -> ${pkg.version} (gitHead=${sha})`);
  stamped++;
}

console.log(`OK: stamped ${stamped} package(s) with sourceSha=${sha}`);
