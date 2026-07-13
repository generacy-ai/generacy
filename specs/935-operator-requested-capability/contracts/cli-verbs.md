# Contract: CLI verbs — new + modified

## New: `generacy cockpit scope add <scope-ref> <issue-ref>`

**Module**: `packages/generacy/src/cli/commands/cockpit/scope.ts` (parent Command)

### Arguments

- `<scope-ref>` (required) — a task-list-bearing issue. Routes through `resolveIssueContext` (accepts qualified `owner/repo#N`, URLs, or bare number inside a repo checkout).
- `<issue-ref>` (required) — the ref to append. Same acceptance grammar.

### Options

- No options for v1.

### Behavior

1. Resolve both refs.
2. Call `writeScopeWithRetry({ mutation: { kind: 'add', ref: issueRef }, scope: scopeRef, gh })`.
3. On success, print `scope add: <issue-ref> → <scope-ref> (shape=<shape>, attempts=<N>, alreadyPresent=<bool>)`.
4. Exit 0 on success (including `alreadyPresent: true`).

### Exit codes

- `0` — mutation applied or noop
- `1` — `ScopeContendedError` (prints `SCOPE_ADD_CONTENDED` + suggested remedy: "retry once, or edit the scope issue body directly")
- `2` — argument-parsing / ref-resolution error
- Other non-zero — unhandled exception (propagates)

### Stdout / stderr

- stdout: one-line success summary (or evidence when noop)
- stderr: error messages prefixed with `cockpit scope add: `

### Interactive prompts

- None. This is a fire-and-forget mutation with a typed success/failure result.

## New: `generacy cockpit scope remove <scope-ref> <issue-ref>`

Same shape as `scope add`, inverts the mutation. Exit code `1` on `SCOPE_ADD_CONTENDED` (single code covers both mutations per Q5).

### Behavior

1. Resolve both refs.
2. Call `writeScopeWithRetry({ mutation: { kind: 'remove', ref: issueRef }, scope: scopeRef, gh })`.
3. Print `scope remove: <issue-ref> ✕ <scope-ref> (attempts=<N>, alreadyAbsent=<bool>)`.

## Modified: `generacy cockpit queue`

### Arguments (unchanged for phase form)

- `<epic-ref> <phase>` — phase form (existing)

### New option

- `--issue <issue-ref>` — single-issue form. Mutually exclusive with positional args.

### Command shape

```
generacy cockpit queue <epic-ref> <phase>             # existing phase form
generacy cockpit queue --issue <issue-ref>            # new single-issue form
```

### Validation

- If `--issue` is passed AND positional `<epic-ref> <phase>` args are also present → exit 2, "Error: cockpit queue: --issue is mutually exclusive with <epic-ref> <phase>"
- If neither positional args nor `--issue` → exit 2, "Error: cockpit queue: either <epic-ref> <phase> or --issue <issue-ref> is required"

### Single-issue form behavior

1. Resolve `--issue` via `resolveIssueContext`.
2. Fetch issue state via `cockpitGh.fetchIssueState`.
3. `classifyRow(ref, ref.repo, workflowLabel, view)` (same classifier as phase form).
4. Same identity resolution (`resolveCockpitIdentity`).
5. Same interactive `Proceed?` confirm (unless `--yes`).
6. Same mutation pair (assign + label).
7. Same output: preview line + summary line — but single-row (not table).

### Reuse

The internal mutation loop from `runQueue` (queue.ts:505-528) refactors into `applyQueueMutation(row, assignee, gh)` shared between phase and issue forms.

### Options preserved

- `--label`, `--repo`, `--assignee`, `--yes` — all still apply in single-issue form.

## `generacy cockpit status` — no CLI-signature change, richer render

For flat-list scope refs (`parsed.phases.length === 0`), render a single ungrouped table:

```
Scope: owner/repo#N  (flat, 4 refs)

STATE      REF              LABEL              …
active     owner/repo#1     process:speckit    …
pending    owner/repo#2     -                  …
```

Header line specifies `(flat, N refs)` or `(phased, N refs)`. When phased with adhoc entries, adhoc refs form their own group with heading `Ad-hoc`.

## `generacy cockpit watch` — no signature change, richer emission

`initial: true` event on mid-stream first-sight (D-1). Emission is driven by the shared `computeTransitions` change; the watch verb doesn't need its own logic changes.

## Command registration

`packages/generacy/src/cli/commands/cockpit/index.ts`:

```typescript
import { scopeCommand } from './scope.js';
// …
command.addCommand(scopeCommand());  // added after resumeCommand()
```

`scopeCommand()` returns a Commander sub-command with two sub-sub-commands (`add`, `remove`).
