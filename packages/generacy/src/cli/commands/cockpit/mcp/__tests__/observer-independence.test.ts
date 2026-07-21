/**
 * #1015 SC-005 regression guard: observer MCP tools MUST NOT import from the
 * claim module or the claim/release handlers. Enforced by static-import scan
 * on the source files (test file lives outside the observer tool list so it
 * doesn't self-trigger).
 *
 * Rationale: observers (`cockpit_status`, `cockpit_context`,
 * `cockpit_await_events`) must remain gated only by their own read semantics,
 * never by the active-driver claim. Scope-mutation tools
 * (`cockpit_scope_add` / `cockpit_scope_remove`) are also asserted so no
 * accidental coupling creeps in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(HERE, '..', 'tools');

const OBSERVER_TOOL_FILES = [
  'cockpit_status.ts',
  'cockpit_context.ts',
  'cockpit_await_events.ts',
] as const;

const NON_OBSERVER_ALSO_CLAIM_FREE = [
  'cockpit_scope_add.ts',
  'cockpit_scope_remove.ts',
] as const;

const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+['"]\.\.\/claim\/[^'"]+['"]/,
  /from\s+['"]\.\.\/tools\/cockpit_claim(?:\.js)?['"]/,
  /from\s+['"]\.\.\/tools\/cockpit_release(?:\.js)?['"]/,
  /from\s+['"]\.\/cockpit_claim(?:\.js)?['"]/,
  /from\s+['"]\.\/cockpit_release(?:\.js)?['"]/,
];

function assertNoClaimImport(fileName: string): void {
  const source = readFileSync(resolve(TOOLS_DIR, fileName), 'utf8');
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    expect(
      pattern.test(source),
      `${fileName} must not import claim internals — regex ${pattern} matched`,
    ).toBe(false);
  }
}

describe('observer-independence (SC-005)', () => {
  for (const file of OBSERVER_TOOL_FILES) {
    it(`observer ${file} does not import claim/ or cockpit_claim / cockpit_release`, () => {
      assertNoClaimImport(file);
    });
  }

  for (const file of NON_OBSERVER_ALSO_CLAIM_FREE) {
    it(`scope-mutator ${file} does not import claim/ or cockpit_claim / cockpit_release`, () => {
      assertNoClaimImport(file);
    });
  }
});
