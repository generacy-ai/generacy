import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckDefinition } from '../types.js';

const PACKAGE_NAME = '@generacy-ai/generacy';

/**
 * Read the expected version from our own package.json.
 */
function getExpectedVersion(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // checks/ → doctor/ → commands/ → cli/ → src/ → packages/generacy/
  const pkgPath = join(thisDir, '..', '..', '..', '..', '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}

/**
 * Compare two semver version strings (major.minor.patch).
 * Returns true if `installed` >= `expected`.
 */
function isVersionSatisfied(installed: string, expected: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);

  const inst = parse(installed);
  const exp = parse(expected);

  for (let i = 0; i < Math.max(inst.length, exp.length); i++) {
    const a = inst[i] ?? 0;
    const b = exp[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }

  return true; // equal
}

export const npmPackagesCheck: CheckDefinition = {
  id: 'npm-packages',
  label: 'NPM Packages',
  category: 'packages',
  dependencies: [],
  priority: 'P2',

  async run(context) {
    const root = context.projectRoot ?? process.cwd();
    const installedPkgPath = join(
      root,
      'node_modules',
      PACKAGE_NAME,
      'package.json',
    );

    // Check if node_modules exists at all
    if (!existsSync(join(root, 'node_modules'))) {
      return {
        status: 'fail',
        message: 'Packages not installed',
        suggestion: 'Run `pnpm install`',
        detail: `Expected node_modules at ${join(root, 'node_modules')}`,
      };
    }

    // Check if our package is installed
    if (!existsSync(installedPkgPath)) {
      return {
        status: 'fail',
        message: `${PACKAGE_NAME} is not installed`,
        suggestion: 'Run `pnpm install`',
        detail: `Expected at ${installedPkgPath}`,
      };
    }

    // Read installed version
    let installedVersion: string;
    try {
      const raw = readFileSync(installedPkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (!pkg.version) {
        return {
          status: 'warn',
          message: `${PACKAGE_NAME} has no version field`,
          suggestion: 'Run `pnpm install` to reinstall packages',
          detail: `File: ${installedPkgPath}`,
        };
      }
      installedVersion = pkg.version;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown read error';
      return {
        status: 'fail',
        message: `Failed to read ${PACKAGE_NAME} package info`,
        suggestion: 'Run `pnpm install` to reinstall packages',
        detail: message,
      };
    }

    // Get expected version from our own package.json
    let expectedVersion: string;
    try {
      expectedVersion = getExpectedVersion();
    } catch {
      // If we can't read our own version, just report the installed one as pass
      return {
        status: 'pass',
        message: `${PACKAGE_NAME} v${installedVersion} installed`,
        detail: `Could not determine expected version for comparison`,
      };
    }

    // Compare versions
    if (!isVersionSatisfied(installedVersion, expectedVersion)) {
      return {
        status: 'warn',
        message: `Version mismatch: installed v${installedVersion}, expected ≥ ${expectedVersion}`,
        suggestion: `Update ${PACKAGE_NAME} to v${expectedVersion} or newer`,
        detail: `Installed: ${installedVersion}, Expected: ≥ ${expectedVersion}`,
      };
    }

    return {
      status: 'pass',
      message: `${PACKAGE_NAME} v${installedVersion} (expected ≥ ${expectedVersion})`,
      detail: `File: ${installedPkgPath}`,
    };
  },
};
