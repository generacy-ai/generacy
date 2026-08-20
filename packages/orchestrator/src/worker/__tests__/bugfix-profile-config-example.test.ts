/**
 * T019 (#1135, US4) — the shipped bugfix-profile docs example cannot drift.
 *
 * `docs/docs/reference/bugfix-profile-config.md` ships ONE copy-pasteable
 * `.generacy/config.yaml` block that opts a repo into the Phase-4 bugfix
 * profile. This test extracts that exact fenced block, validates it against the
 * SHIPPED P4 config schema (`OrchestratorSettingsSchema` from `@generacy-ai/config`),
 * and resolves it through the SHIPPED precedence (`resolveWorkflowOverrides` from
 * `worker/config.ts`) — so if either the schema or the resolver changes shape,
 * or someone edits the doc into an invalid state, this fails (FR-008 / SC-007 /
 * Q5=A). Ships NO product behavior (#1135 FR-010): read-and-assert only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { OrchestratorSettingsSchema, type OrchestratorSettings } from '@generacy-ai/config';
import { resolveWorkflowOverrides, type WorkerConfig } from '../config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/orchestrator/src/worker/__tests__ → repo root → docs file.
const DOC_PATH = resolve(
  HERE,
  '../../../../../docs/docs/reference/bugfix-profile-config.md',
);

const TARGETED_COMMAND =
  'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test';

/**
 * Pull the single ```yaml fenced block whose info string names
 * `.generacy/config.yaml` out of the shipped doc. Fails loudly (returns nothing
 * matched → test throws) if the doc drops or renames that block.
 */
function extractConfigYaml(markdown: string): string {
  const fence = /```yaml\s+title="\.generacy\/config\.yaml"\n([\s\S]*?)```/m;
  const match = fence.exec(markdown);
  if (!match) {
    throw new Error(
      'bugfix-profile-config.md no longer ships a ```yaml title=".generacy/config.yaml" block',
    );
  }
  return match[1]!;
}

describe('#1135 T019 — bugfix-profile docs example stays valid (US4)', () => {
  const markdown = readFileSync(DOC_PATH, 'utf8');
  const yamlText = extractConfigYaml(markdown);
  const doc = parseYaml(yamlText) as { orchestrator?: unknown };

  it('validates against the shipped OrchestratorSettingsSchema', () => {
    // The doc block is a full `.generacy/config.yaml`; only the `orchestrator`
    // subtree is the orchestrator settings surface.
    expect(() => OrchestratorSettingsSchema.parse(doc.orchestrator)).not.toThrow();
  });

  it('resolves to the bugfix profile through resolveWorkflowOverrides (SC-007)', () => {
    const settings = OrchestratorSettingsSchema.parse(doc.orchestrator) as OrchestratorSettings;

    // Minimal cluster-tier config: the doc pins every bugfix field at the
    // workflow tier, so the cluster fallbacks below must never win.
    const config = {
      validateCommand: 'pnpm test && pnpm build',
      preValidateCommand: '',
    } as WorkerConfig;

    const resolved = resolveWorkflowOverrides(config, settings, 'speckit-bugfix');

    // The five load-bearing knobs the doc advertises.
    expect(resolved.review.profile).toBe('verification');
    expect(resolved.review.blockingSeverity).toBe('critical');
    expect(resolved.review.failThenPass).toBe(true);
    expect(resolved.maxRemediations).toBe(2);
    expect(resolved.validateCommand).toBe(TARGETED_COMMAND);
  });

  it('does not leak the bugfix profile onto speckit-feature runs', () => {
    const settings = OrchestratorSettingsSchema.parse(doc.orchestrator) as OrchestratorSettings;
    const config = {
      validateCommand: 'pnpm test && pnpm build',
      preValidateCommand: '',
    } as WorkerConfig;

    const feature = resolveWorkflowOverrides(config, settings, 'speckit-feature');

    // Feature falls through to the built-in review baseline + its own maxRemediations
    // default (3) + the cluster validate command — untouched by the bugfix block.
    expect(feature.review.profile).toBe('standard');
    expect(feature.review.failThenPass).toBe(false);
    expect(feature.maxRemediations).toBe(3);
    expect(feature.validateCommand).toBe('pnpm test && pnpm build');
  });
});
