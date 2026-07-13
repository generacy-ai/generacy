# Quickstart: `generacy cockpit context`

## Install

Same as any other cockpit verb — ships in `@generacy-ai/generacy`.

```bash
pnpm install                      # from repo root
pnpm --filter @generacy-ai/generacy build
```

Or use the workspace binary directly:

```bash
node packages/generacy/dist/cli/index.js cockpit context <issue>
```

## Usage

```bash
# Fully-qualified ref
generacy cockpit context generacy-ai/generacy#807

# Full URL
generacy cockpit context https://github.com/generacy-ai/generacy/issues/807

# Bare number (only works when cwd is a git repo whose origin points at github.com)
cd path/to/generacy-repo
generacy cockpit context 807
```

**Flags**: none — the verb takes only `<issue>`. `--repo` is intentionally *not* supported (spec Q5 → A).

## What comes out

`context` classifies the issue's `waiting-for:*` gate and emits one JSON line on stdout. The `bundle.gate` field is the discriminator:

- `waiting-for:clarification` → clarification bundle (spec + plan + code refs + unresolved clarification comment)
- `waiting-for:implementation-review` → PR bundle (PR metadata + diff + checks)
- `waiting-for:spec-review` | `waiting-for:plan-review` | `waiting-for:tasks-review` → artifact-paths bundle (all three of spec/plan/tasks, `null` when missing)

Schemas: [contracts/](./contracts/)

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Bundle emitted successfully |
| 1 | `gh` command failed or returned unexpected JSON |
| 2 | Ref-parse failed (unknown shape, bare number without cwd inference) |
| 3 | Gate refusal — no `waiting-for:*` label on the issue, unsupported gate, `completed:validate` passed in (message points at `cockpit merge`), or PR-scoped gate has no resolvable PR |

## Examples

### Clarification gate

```bash
$ generacy cockpit context generacy-ai/generacy#807
{"issue":"generacy-ai/generacy#807","gate":"waiting-for:clarification","clarificationComment":{"body":"Q1: …","author":"speckit-bot","createdAt":"2026-07-06T14:22:11Z","url":"https://github.com/generacy-ai/generacy/issues/807#issuecomment-…"},"spec":{"path":"specs/807-…/spec.md","body":"…"},"plan":null,"codeReferences":{"prUrl":"https://github.com/generacy-ai/generacy/pull/810","touchedFiles":["packages/cockpit/src/gh/wrapper.ts"],"diffPatch":"…"}}
```

### Implementation-review gate

```bash
$ generacy cockpit context generacy-ai/generacy#807
{"issue":"generacy-ai/generacy#807","gate":"waiting-for:implementation-review","pr":{"number":810,"title":"…","url":"…","base":"develop","head":"807-…","body":"…","author":"christrudelpw","state":"OPEN","draft":false},"diff":"diff --git a/…","diffTruncated":false,"checks":[{"name":"lint","state":"SUCCESS"},{"name":"test","state":"SUCCESS"}]}
```

### Artifact-paths gate (spec-review, plan-review, or tasks-review)

```bash
$ generacy cockpit context generacy-ai/generacy#807
{"issue":"generacy-ai/generacy#807","gate":"waiting-for:plan-review","artifacts":{"spec":{"path":"specs/807-…/spec.md","body":"…"},"plan":{"path":"specs/807-…/plan.md","body":"…"},"tasks":null}}
```

### Refusal — no waiting-for label

```bash
$ generacy cockpit context generacy-ai/generacy#807
Error: cockpit context: gate refusal: issue generacy-ai/generacy#807 has no waiting-for:* label (labels: phase:implement, area:cockpit)
$ echo $?
3
```

### Refusal — completed:validate (use `cockpit merge`)

```bash
$ generacy cockpit context generacy-ai/generacy#807
Error: cockpit context: gate refusal: issue generacy-ai/generacy#807 is at completed:validate — use `generacy cockpit merge` to merge its PR
$ echo $?
3
```

### Refusal — PR-scoped gate with no linked PR

```bash
$ generacy cockpit context generacy-ai/generacy#807
Error: cockpit context: gate refusal: issue generacy-ai/generacy#807 at waiting-for:implementation-review but no linked PR resolved
$ echo $?
3
```

## Available commands after this change

```text
generacy cockpit
├── watch             (unchanged)
├── status            (unchanged)
├── advance           (unchanged)
├── merge             (unchanged)
├── queue             (unchanged)
└── context <issue>   NEW — replaces state / clarify-context / review-context
```

**Removed** in this change: `state`, `clarify-context`, `review-context`. Any tooling that calls them must switch to `context` and dispatch on `bundle.gate`.

## Troubleshooting

**Exit 2 with "bare issue number … is not accepted"** — you passed just a number (e.g. `807`) from a directory whose git origin is not on github.com. Use `owner/repo#N` or `cd` into a git checkout of the target repo.

**Exit 3 with no `waiting-for:*` label** — the issue is not at a gate `context` handles. Check `gh issue view <n> --json labels` and either add the right label (if the workflow forgot) or move on (if the issue is past the gate).

**Exit 3 with "no linked PR resolved" but the PR clearly exists** — the label is on the issue, but `gh` couldn't link them. Check that the PR body has `Closes #<n>` or `Fixes #<n>`, or that the `linked:<n>` search returns it.

**Exit 1 with gh JSON shape mismatch** — the `gh` CLI version emitted a shape the Zod schema doesn't recognize. File a bug with the `gh --version` output; the schemas may need an upstream update.

## Migration notes for existing callers

- `generacy cockpit state <issue>` → `generacy cockpit context <issue>` and read `bundle.gate`.
- `generacy cockpit clarify-context <issue>` → `generacy cockpit context <issue>` (bundle shape unchanged except for the added `gate` field).
- `generacy cockpit review-context <issue> [--repo <r>]` → `generacy cockpit context <issue>` (drop `--repo`; the repo comes from the ref shape). Bundle shape unchanged except for the added top-level `issue` and `gate` fields.
