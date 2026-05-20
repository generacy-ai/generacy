#!/usr/bin/env node
// Packs every non-private workspace package via `pnpm pack` and asserts that
// no dependency in any tarball's package.json still uses the `workspace:`
// protocol. Run after `pnpm changeset version` (or `--snapshot ...`) and
// before `pnpm publish`, so a leak is caught before it reaches the registry.
//
// Context: `prepublishOnly` per-package can't perform this check because it
// runs before pnpm's pack-time rewrite. The published tarball is what matters,
// so we pack each package and inspect the manifest pnpm actually emitted.

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const packagesDir = join(repoRoot, 'packages');
const depFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const leaks = [];

const tmp = mkdtempSync(join(tmpdir(), 'verify-pack-'));

try {
  for (const dir of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, dir);
    const pkgPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.private || !pkg.name) continue;

    const packDest = join(tmp, dir);
    execSync(`pnpm pack --pack-destination "${packDest}"`, {
      cwd: pkgDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const tgz = readdirSync(packDest).find(f => f.endsWith('.tgz'));
    if (!tgz) {
      leaks.push(`${pkg.name}: pnpm pack produced no tarball`);
      continue;
    }

    const manifest = execSync(`tar -xzOf "${join(packDest, tgz)}" package/package.json`, {
      encoding: 'utf8',
    });
    const packed = JSON.parse(manifest);

    for (const field of depFields) {
      const deps = packed[field];
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          leaks.push(`${pkg.name} -> ${field}.${name}: ${version}`);
        }
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (leaks.length > 0) {
  console.error('ERROR: workspace: protocol leaked into packed tarballs:');
  for (const leak of leaks) console.error(`  ${leak}`);
  console.error('\npnpm pack should rewrite workspace: deps to actual versions.');
  console.error('Investigate whether `changeset version` ran, or the publish');
  console.error('command bypassed pnpm pack (e.g. ran `npm publish` directly).');
  process.exit(1);
}

console.log('OK: no workspace: protocol leaks in packed tarballs');
