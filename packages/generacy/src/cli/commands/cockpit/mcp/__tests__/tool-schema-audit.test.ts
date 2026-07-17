/**
 * #928 Q3 → B — Reference-Kind Audit Table.
 *
 * Independent third opinion catching MCP-vs-CLI ref-kind drift. Instead of
 * parsing one artifact against the other (which the pre-#928 tests did and
 * missed the inversion because both sides drifted together), this test
 * carries its own hardcoded table and cross-checks BOTH artifacts against
 * it. When a new cockpit_* MCP tool is added, this test forces the table
 * update.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '..', 'tools');
const CLI_DIR = join(__dirname, '..', '..');

type RefKind = 'issue' | 'epic' | 'scope';

/**
 * The audit table. Each entry names the wrapped CLI verb's REF kind — this
 * is the third opinion against schema/source drift.
 *
 *   'issue' — the wrapped verb operates on a single issue ref
 *   'epic'  — the wrapped verb operates on an epic ref
 */
const EXPECTED_KIND: Record<string, RefKind> = {
  cockpit_status: 'epic',
  cockpit_context: 'issue',
  cockpit_advance: 'issue',
  cockpit_resume: 'issue',
  cockpit_queue: 'epic',
  cockpit_merge: 'issue',
  cockpit_await_events: 'epic',
  // #935 — scope-mutation verbs. `scope` semantics: input carries both a
  // `scope` (target issue whose body is edited) and `issue` (the ref to
  // add/remove). Both fields are asserted below.
  cockpit_scope_add: 'scope',
  cockpit_scope_remove: 'scope',
  // #958 — deterministic clarification-answer relay. Wraps an issue ref
  // (marker-stamped comment posted + completed:clarification applied).
  cockpit_relay_clarify_answers: 'issue',
};

/**
 * How the schema field name is expected to appear in the Zod schema for
 * each kind. The MCP schema for a 'epic'-kind verb MUST declare an `epic:`
 * field; an 'issue'-kind verb MUST declare an `issue:` field.
 */
const SCHEMA_FIELD_BY_KIND: Record<RefKind, string> = {
  issue: 'issue',
  epic: 'epic',
  scope: 'scope',
};

/**
 * How the Commander CLI verb file is expected to name its positional
 * argument for each kind. Case-insensitive substring match to tolerate
 * angle-bracket variants (`<epic-ref>`, `<epic>`, `<issue>`, `<issue-ref>`).
 */
const CLI_TOKENS_BY_KIND: Record<RefKind, string[]> = {
  issue: ['<issue>', '<issue-ref>', '[issue]'],
  epic: ['<epic>', '<epic-ref>'],
  scope: ['<scope-ref>'],
};

/**
 * Map each MCP tool name to its Commander verb file (relative to CLI_DIR).
 * `cockpit_await_events` is a special case: it does not have a companion
 * CLI verb (long-poll sensor is MCP-exclusive), so it uses null.
 */
const CLI_VERB_FILE: Record<string, string | null> = {
  cockpit_status: 'status.ts',
  cockpit_context: 'context.ts',
  cockpit_advance: 'advance.ts',
  cockpit_resume: 'resume.ts',
  cockpit_queue: 'queue.ts',
  cockpit_merge: 'merge.ts',
  cockpit_await_events: null,
  cockpit_scope_add: 'scope.ts',
  cockpit_scope_remove: 'scope.ts',
  // #958 — MCP-first tool. `runClarifyRelay` is not exposed as a top-level
  // Commander verb in v1 (the skill invokes the MCP tool directly).
  cockpit_relay_clarify_answers: null,
};

const schemasSource = readFileSync(
  join(__dirname, '..', 'schemas.ts'),
  'utf-8',
);

describe('#928 Q3 → B tool-schema audit table', () => {
  it('table names every cockpit_* MCP tool present under tools/ (forcing function)', () => {
    const filenames = readdirSync(TOOLS_DIR).filter(
      (f) => f.startsWith('cockpit_') && f.endsWith('.ts'),
    );
    const toolNames = filenames.map((f) => f.replace(/\.ts$/, ''));
    const tableEntries = Object.keys(EXPECTED_KIND);
    for (const tool of toolNames) {
      expect(
        tableEntries,
        `${tool} lacks an entry in EXPECTED_KIND — update the audit table when adding a new cockpit_* MCP tool`,
      ).toContain(tool);
    }
  });

  for (const [toolName, kind] of Object.entries(EXPECTED_KIND)) {
    describe(`${toolName} → ${kind}`, () => {
      it(`schemas.ts declares a "${SCHEMA_FIELD_BY_KIND[kind]}:" field on the tool's input schema`, () => {
        const schemaName = mcpToolToSchemaName(toolName);
        const source = schemasSource;
        // Extract the schema definition body.
        const bodyRegex = new RegExp(
          `${schemaName}\\s*=\\s*z[\\s\\S]*?\\.strict\\(\\)`,
          'm',
        );
        const match = bodyRegex.exec(source);
        expect(match, `${schemaName} not found or not .strict() in schemas.ts`).not.toBeNull();
        const body = match![0];
        const fieldRegex = new RegExp(
          `\\b${SCHEMA_FIELD_BY_KIND[kind]}\\s*:`,
        );
        expect(fieldRegex.test(body), `${schemaName} must declare a "${SCHEMA_FIELD_BY_KIND[kind]}:" field`).toBe(true);
      });

      const verbFile = CLI_VERB_FILE[toolName];
      if (verbFile !== null) {
        it(`CLI verb ${verbFile} declares a ${CLI_TOKENS_BY_KIND[kind].join(' or ')} argument`, () => {
          const source = readFileSync(join(CLI_DIR, verbFile), 'utf-8');
          const tokens = CLI_TOKENS_BY_KIND[kind];
          const matches = tokens.some((t) => source.includes(t));
          expect(matches, `${verbFile} must include one of ${tokens.join(', ')} as its argument label`).toBe(true);
        });
      }
    });
  }
});

function mcpToolToSchemaName(toolName: string): string {
  // cockpit_merge → CockpitMergeInputSchema
  // Special case: cockpit_await_events → AwaitEventsInputSchema (no `Cockpit` prefix)
  if (toolName === 'cockpit_await_events') return 'AwaitEventsInputSchema';
  const camel = toolName
    .split('_')
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join('');
  return `${camel}InputSchema`;
}
