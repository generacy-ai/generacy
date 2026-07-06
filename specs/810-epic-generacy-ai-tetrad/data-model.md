# Data Model: #810

No new runtime entities are introduced by this PR. The data model here documents the two contracts the sweep depends on: the `CockpitConfigSchema` strip-mode invariant and the legacy-key fixture shape that locks it in.

## Entity 1 — `CockpitConfigSchema` (unchanged, contract locked)

**Definition** (in `packages/cockpit/src/config/schema.ts:3-5`):

```ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
});
```

**Fields**:

| Field | Type              | Presence  | Notes                                                        |
| ----- | ----------------- | --------- | ------------------------------------------------------------ |
| owner | `string \| undefined` | optional  | Non-empty string when set. Falls back to `gh auth status` login. |

**Strip-mode invariant (R4)**:

- Zod defaults to *strip* mode on `z.object()` — unknown keys are silently dropped from the parsed output.
- No `.strict()` or `.passthrough()` modifiers may be added without breaking legacy configs.
- Observable behavior:
  - Input `{ owner: 'alice', foo: 'bar' }` → parsed `{ owner: 'alice' }`.
  - Input `{ owner: 'alice', orchestrator: { … }, stuckThresholdMinutes: 30 }` → parsed `{ owner: 'alice' }`.
  - Input with `.strict()` swap would throw `ZodError` on both examples above.

**Validation rules**:

- `owner`: `z.string().min(1)` — reject empty string, allow undefined.
- All other keys: dropped silently under strip mode.

**Relationships**:

- Loaded by `loadCockpitConfig()` in `packages/cockpit/src/config/loader.ts:70` from `doc['cockpit']` sub-block of `.generacy/config.yaml`. Top-level keys never reach the schema.

## Entity 2 — Legacy-config fixture (NEW)

**Path**: `packages/cockpit/src/__tests__/fixtures/config-samples/legacy-orchestrator-keys.yaml`

**Shape**:

```yaml
cockpit:
  owner: alice
  orchestrator:
    url: https://example.invalid
    token: legacy-token
  stuckThresholdMinutes: 30
```

**Purpose**: exercise Zod strip mode with keys the schema explicitly no longer knows about. The `orchestrator` and `stuckThresholdMinutes` fields are ex-fields removed by PR #808. A user upgrading from a pre-#808 cockpit release will have these keys in their config; the loader must not throw on them.

**Field breakdown**:

| YAML key                          | Nesting               | Reaches schema? | Expected parse result             |
| --------------------------------- | --------------------- | --------------- | --------------------------------- |
| `cockpit.owner`                   | inside `cockpit:`     | yes             | `parsed.owner === 'alice'`        |
| `cockpit.orchestrator`            | inside `cockpit:`     | yes             | dropped → `parsed.orchestrator === undefined` |
| `cockpit.orchestrator.url`        | inside `cockpit:`     | yes (via parent) | dropped with parent               |
| `cockpit.orchestrator.token`      | inside `cockpit:`     | yes (via parent) | dropped with parent               |
| `cockpit.stuckThresholdMinutes`   | inside `cockpit:`     | yes             | dropped → `parsed.stuckThresholdMinutes === undefined` |

**Why nested (not top-level)**: `loadCockpitConfig()` passes only `doc['cockpit']` to `CockpitConfigSchema.parse()`. Top-level sibling keys never touch the schema and are useless as a strip-mode probe. Clarification Q3 walks through this.

## Entity 3 — Test case (NEW)

**Location**: `packages/cockpit/src/__tests__/config-loader.test.ts` — one new `it()` block appended to the existing `describe('loadCockpitConfig', …)`.

**Shape**:

```ts
it('strips legacy orchestrator/stuckThresholdMinutes keys nested under cockpit: (R4 strip mode)', async () => {
  await writeConfig(
    cwd,
    'cockpit:\n  owner: alice\n  orchestrator:\n    url: https://example.invalid\n    token: legacy-token\n  stuckThresholdMinutes: 30\n',
  );
  const result = await loadCockpitConfig({
    cwd,
    whoami: async () => null,
  });
  expect(result.config.owner).toBe('alice');
  expect((result.config as unknown as { orchestrator?: unknown }).orchestrator).toBeUndefined();
  expect((result.config as unknown as { stuckThresholdMinutes?: unknown }).stuckThresholdMinutes).toBeUndefined();
});
```

**Assertion breakdown**:

| Assertion                                                  | Guards against                                         |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `await` completes (no throw)                               | Future `.strict()` swap on `CockpitConfigSchema`.      |
| `result.config.owner === 'alice'`                          | Regression where strip-mode drops known keys too.      |
| `parsed.orchestrator === undefined`                        | Future `.passthrough()` swap (would leak the key back). |
| `parsed.stuckThresholdMinutes === undefined`               | Same — second key, second probe.                       |

**Type-level note**: the `as unknown as { … }` cast is deliberate. `CockpitConfig` type has no `orchestrator` or `stuckThresholdMinutes` fields; without the cast, TS would refuse the `.toBeUndefined()` assertion. The cast is what makes the "field is dropped from the type" and "field is dropped from the runtime value" both observable in the same test.

## Relationships summary

```text
.generacy/config.yaml
  └── cockpit:                              (only sub-block loader forwards)
        ├── owner (known)                   → CockpitConfigSchema → parsed.owner
        ├── orchestrator (unknown, legacy)  → CockpitConfigSchema → DROPPED (strip)
        └── stuckThresholdMinutes (legacy)  → CockpitConfigSchema → DROPPED (strip)
```
