# Clarifications

## Batch 1 — 2026-07-21T19:16:00Z

### Q1: Compound generation string format
**Context**: Three gate types have multi-input generation sources per the plan doc table — `artifact-review` (kind + head SHA), `escalation` (subtype + triggering label/state + occurrence counter), `scope-drained` (tracking-issue ref + drain counter). `gateKey` interpolates a single `<generation>` token, so each helper must concatenate its inputs deterministically. The delimiter choice bakes into every `gateId` forever, so it must be fixed here.
**Question**: What delimiter (and format) should compound-input helpers use when joining their parts into the returned generation string?
**Options**:
- A: Colon-joined lowercase, e.g. `artifact-review` → `"spec-review:abc1234"`, `escalation` → `"stalled:agent:error:3"`, `scope-drained` → `"generacy-ai/generacy#900:2"`. Matches `gateKey`'s own `:` delimiter.
- B: Hyphen-joined, e.g. `"spec-review-abc1234"`, `"stalled-agent-error-3"`, `"generacy-ai-generacy-900-2"`. Avoids collision with `gateKey`'s `:` separators.
- C: Structured stringification via `JSON.stringify` of an ordered tuple, e.g. `'["spec-review","abc1234"]'`. Zero ambiguity, but longer strings.
- D: SHA-256 hex of the ordered tuple (helper hashes internally, returns a short hex prefix). Keeps `gateKey` uniformly short but hides input semantics from operators reading log lines.

**Answer**: A — Colon-joined lowercase generation strings (e.g. `spec-review:abc1234`), matching gateKey's own `:` delimiter.
**Rationale:** `gateId = sha256(gateKey)` so gateKey is only ever hashed, never parsed back — collision-avoidance (hyphen) and disambiguation (JSON/hash) buy nothing, while colon-join keeps generations human-readable in operator logs; the fixed `owner/repo#N:gateType:` prefix rules out realistic cross-tuple collisions.

### Q2: Package export path for the gates module
**Context**: FR-011 explicitly leaves two options open: bundle the gates API into the existing `.` root export, or expose it as a named subpath `./gates`. Downstream issues (orchestrator routes, MCP tools, cloud mirror) will hard-code the import path once this ships, so changing it later is a coordinated breaking change.
**Question**: How should the gates API be surfaced in `packages/cockpit/package.json`'s `exports` field?
**Options**:
- A: Bundled into the existing `.` root export — downstream imports are `import { GateRecordSchema } from '@generacy-ai/cockpit'`. Fewer entry points; matches how `GhWrapper` and other cockpit APIs ship today.
- B: Separate `./gates` subpath — downstream imports are `import { GateRecordSchema } from '@generacy-ai/cockpit/gates'`. Isolates the gates surface; makes it explicit which callers depend on the wire contracts vs the rest of the package.

**Answer**: A — Bundle the gates API into the existing `.` root export (`import { GateRecordSchema } from '@generacy-ai/cockpit'`).
**Rationale:** #1020's acceptance criteria says verbatim "Schemas exported from the package root"; the package exposes only `.` today and `index.ts` aggregates all exports at root, so a `./gates` subpath breaks convention for no isolation gain.

### Q3: `options[]` element field constraints
**Context**: The plan doc shows an option shape `{id, label, description, recommended?}` but doesn't specify whether `description` is required, whether `recommended` has a default when omitted, or whether `options[]` may be empty. These constraints shape every downstream renderer (the cloud inbox UI, the local `AskUserQuestion` fallback) and the fixture set.
**Question**: What are the schema-level rules for `options[]` and its elements?
**Options**:
- A: `description` required (non-empty string); `recommended` optional (undefined = not recommended, no default coercion); `options[]` may be empty (`.min(0)`).
- B: `description` optional; `recommended` defaults to `false` via `.default(false)`; `options[]` requires `.min(1)` when `allowFreeText: false`, otherwise may be empty.
- C: `description` required; `recommended` optional (no default); `options[]` requires `.min(1)` unconditionally (every gate must offer at least one canned option).
- D: `description` optional; `recommended` optional (no default); `options[]` may be empty unconditionally — callers own the "at least one path forward" invariant.

**Answer**: A — `description` required (non-empty string); `recommended` optional (undefined = not recommended, no default coercion); `options[]` may be empty (`.min(0)`).
**Rationale:** No `.default(false)` preserves round-trip fixture fidelity; empty `options[]` must stay legal because the free-text escape hatch (Q4) always guarantees a path forward, so a `.min(1)` would wrongly reject pure free-text gates.

### Q4: `allowFreeText` invariant
**Context**: The plan doc's Gate record example comments `"allowFreeText": true, // every gate keeps an 'Other'-style escape hatch`, implying it is always true in practice. The schema currently accepts both `true` and `false`. Whether this is a schema-enforced invariant or a caller convention affects both the Zod definition and the fixture set (do we need a `allowFreeText: false` fixture at all?).
**Question**: Should the schema enforce `allowFreeText: true` as an invariant, or accept both values?
**Options**:
- A: Enforce `allowFreeText: z.literal(true)` — schema rejects any gate that omits the free-text escape hatch; matches the plan doc's stated intent verbatim; no `allowFreeText: false` fixture needed.
- B: Accept `z.boolean()` (both values) — leave the "always true" rule as a caller convention; fixtures cover both true and false to exercise the schema. Matches the JSON's structural type but not the plan doc's aspirational rule.
- C: Accept `z.boolean().default(true)` — permissive but coerces omitted field to `true`; downstream code can rely on the field being present.

**Answer**: A — `allowFreeText: z.literal(true)` — enforce as a schema invariant; no `allowFreeText: false` fixture needed.
**Rationale:** The plan doc annotates the field "every gate keeps an 'Other'-style escape hatch" as an invariant, not a per-gate choice; `z.literal(true)` encodes the contract so a driving session can never emit a gate that blocks with no answerable path.

### Q5: `artifact-review` kind argument
**Context**: The `deriveArtifactReviewGeneration` helper takes an `artifact kind` per the plan doc table. Existing speckit gates in this repo are `spec-review`, `plan-review`, `tasks-review`, `clarification-review`, `implementation-review` (the last is its own gateType, not an artifact kind). Whether the helper accepts a closed enum or a free string determines whether the schema catches typos at compile time or defers them to runtime.
**Question**: How should the helper's `kind` argument be typed?
**Options**:
- A: Closed Zod enum: `z.enum(['spec-review', 'plan-review', 'tasks-review', 'clarification-review'])`. Compile-time safety; adding a new artifact kind requires bumping this package.
- B: Free-form string with a documented convention. Zero coupling to speckit's phase vocabulary; other workflows can introduce their own artifact kinds without changing this package.
- C: Closed enum sourced from a shared constant re-exported from `@generacy-ai/workflow-engine` (or wherever speckit phase names already live) to avoid duplicate vocabulary drift.

**Answer**: A — Closed local Zod enum `['spec-review','plan-review','tasks-review','clarification-review']` for the artifact `kind`.
**Rationale:** workflow-engine's `GateType` is a permissive `| string` union with no closed exported constant to source (so option C has nothing concrete), and a local enum gives compile-time typo safety over the four stable review stages while keeping #1020 self-contained.
