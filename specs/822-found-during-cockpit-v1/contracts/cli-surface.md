# Contract: Cockpit CLI verb surfaces (post-fix)

**Feature**: `822-found-during-cockpit-v1` | **Date**: 2026-07-07

Documents the CLI argument surface for `generacy cockpit status`, `watch`, and `queue` after this fix lands. Consumed by the shipped `claude-plugin-cockpit` and by the rev-3 catalog in `docs/epic-cockpit-plan.md` (tetrad-development).

## `generacy cockpit status <epic-ref> [--json]`

**Usage**:
```
generacy cockpit status <epic-ref> [--json]
```

**Arguments**:
- `<epic-ref>` (required, positional) — one of:
  - `<n>` — bare issue number; resolves `owner/repo` from the cwd's `git remote get-url origin`.
  - `<owner>/<repo>#<n>`
  - `https://github.com/<owner>/<repo>/issues/<n>` (also accepts `/pull/<n>`)

**Options**:
- `--json` — emit a single-line JSON envelope and exit. Disables color.

**Removed**:
- ~`--epic <ownerRepoIssue>`~ — replaced by the positional `<epic-ref>`.
- ~`--repo <owner/repo>`~ — never existed on `status`; regression-guard only (FR-003, Q5→A).

**Exit codes**:
- `0` — snapshot rendered.
- `1` — non-parse failure (gh IO, etc.).
- `2` — parse failure — `Error: cockpit status: parse issue: <reason>` on stderr. `<reason>` enumerates all three accepted forms.

## `generacy cockpit watch <epic-ref> [--interval <ms>] [--safety-cap <n>]`

**Usage**:
```
generacy cockpit watch <epic-ref> [--interval <ms>] [--safety-cap <n>]
```

**Arguments**:
- `<epic-ref>` (required, positional) — same grammar as `status`.

**Options**:
- `--interval <ms>` — poll interval in ms (default 30000, floor 15000).
- `--safety-cap <n>` — warn when per-poll item count exceeds this (default 1000).

**Removed**:
- ~`--epic <ownerRepoIssue>`~ — replaced by the positional `<epic-ref>`.

**Exit codes**:
- `0` — clean SIGINT/SIGTERM shutdown.
- `1` — non-parse failure (initial `resolveEpic` failed for a non-parse reason).
- `2` — parse failure — `Error: cockpit watch: parse issue: <reason>` on stderr.

**Invariant**: the bare-number → `owner/repo` inference fires **once** at command start. Poll re-`resolveEpic` calls receive the already-expanded string; no repeated `git` subprocess spawn per interval.

## `generacy cockpit queue <epic-ref> <phase> [--label <name>] [--repo <owner/repo>] [--assignee <login>] [--yes]`

**Usage**: **unchanged from today** (FR-009 — byte-identical argument surface).

**Arguments**:
- `<epic-ref>` (required, positional) — same grammar as `status` (now accepts bare number in addition to the two forms `queue` accepted before this fix).
- `<phase>` (required, positional) — phase token, matched case-insensitively against the first token of a `###` heading in the epic body.

**Options**:
- `--label <name>` — workflow label (default `process:speckit-feature`).
- `--repo <owner/repo>` — **enqueue target** repo, not a ref-resolution override. Unaffected by this fix (Q5→A).
- `--assignee <login>` — override the default cluster-account assignee.
- `--yes` — skip the interactive confirmation prompt.

**Exit codes**: unchanged.

## Error shape (all three verbs)

All ref-parse failures emit the same shape via `resolveIssueContext`:

```
Error: cockpit <verb>: parse issue: <reason>
```

Exit code `2`. `<reason>` for garbage input:

```
unrecognized issue ref "<input>". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.
```

`<reason>` for bare-number in a directory without a resolvable git origin:

```
could not infer owner/repo: 'git remote get-url origin' failed (exit <n>): <stderr>
```

## Ref grammar (canonical)

Extracted from `packages/generacy/src/cli/commands/cockpit/resolver.ts:50-52`:

| Form                                        | Example                                       | Resolution               |
|---------------------------------------------|-----------------------------------------------|--------------------------|
| Bare number                                 | `1`                                           | `owner/repo` from cwd origin |
| `<owner>/<repo>#<n>`                        | `generacy-ai/generacy#822`                    | Direct                   |
| Full GitHub URL (`/issues/<n>` or `/pull/<n>`) | `https://github.com/generacy-ai/generacy/issues/822` | Direct                   |

**Not accepted**:
- `#<n>` (leading `#` without `owner/repo`)
- `<owner>/<repo>` (missing `#<n>`)
- Multi-repo refs (`owner/repo#N,owner2/repo2#M`) — spec §Out-of-Scope, `--repos` intentionally dropped in #806.

## Plugin contract

`claude-plugin-cockpit`'s `status.md` and `watch.md` — unchanged. They already pass `$ARGUMENTS` positionally, matching the surface documented above. SC-005 asserts this.

## Rev-3 catalog alignment

Rev-3 catalog (in `docs/epic-cockpit-plan.md` in `tetrad-development`) specifies the positional `<epic-ref>` grammar for all three verbs. This fix aligns the CLI to the catalog; the catalog does not need to change.
