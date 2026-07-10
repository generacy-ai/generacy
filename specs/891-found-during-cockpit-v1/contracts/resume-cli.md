# Contract: `generacy cockpit resume <issue-ref>` — CLI surface

## Command

```
generacy cockpit resume [<issue>] [--workflow <name>]
```

## Arguments

| Position | Name | Required | Type | Description |
|---|---|---|---|---|
| 1 | `issue` | Yes | `string` | Issue ref. Accepted forms: bare number (`42`), `<owner>/<repo>#<n>` (`generacy-ai/generacy#42`), or full URL (`https://github.com/generacy-ai/generacy/issues/42`). Bare numbers require a resolvable GitHub origin in cwd (per `resolveIssueContext`). |

## Options

| Flag | Type | Required | Description |
|---|---|---|---|
| `--workflow <name>` | `string` | No | Workflow name override. Defaults to the value of the issue's `workflow:<name>` label, or `speckit-feature` if absent (matching `label-monitor-service.ts:resolveWorkflowFromLabels`). |

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Happy path — issue re-armed AND labels mutated. Log line names the phase and gate. |
| `0` | No-op — issue has no `failed:<phase>` label; nothing to re-arm. Log line explains. |
| `1` | Remote/transport failure — `gh` API call error mid-sequence. Stderr names the failing call. |
| `2` | Argument error — missing `<issue>`, malformed ref, unresolvable bare number. |
| `3` | Refusal — ambiguous or non-re-armable state. Stderr names the offending labels. See "Refusal branches" below. |

## Refusal branches (all exit 3, all with evidence, all zero mutations)

| Branch | Trigger | Evidence line |
|---|---|---|
| Multiple failed labels | Fetched label set contains ≥2 `failed:*` labels | `refusing to resume: multiple failed:* labels present: [failed:a, failed:b]` |
| Unknown phase | `failed:<phase>` where `<phase>` is not a `WorkflowPhase` | `refusing to resume: unknown phase "<phase>" in label "failed:<phase>"` |
| No preceding gate | `<phase>` has no gate `G` in effective `GATE_MAPPING` with `resumeFrom === <phase>` | `refusing to resume: phase "<phase>" has no preceding gate; use \`process:<workflow>\` label to re-queue from the beginning instead` |
| Conflicting waiting | Existing `waiting-for:<other-gate>` ≠ the derived `<preceding-gate>` | `refusing to resume: conflicting waiting-for:<other-gate> already present; derived preceding-gate is <preceding-gate>` |

## Side Effects (happy path)

In order:

1. Read: `gh.fetchIssueLabels(nwo, n)` — one call.
2. Add: `gh.addLabels(nwo, n, [waiting-for:<preceding-gate>, completed:<preceding-gate>, agent:paused])` — one call.
3. Remove: `gh.removeLabels(nwo, n, [failed:<phase>, ...conditionalRemovals])` where `conditionalRemovals` includes `agent:error` and `phase:<phase>` only when present in step 1's fetched set — one call.
4. Write to stdout: single log line (see below).

**No comment is posted**. (Diverges intentionally from `advance` — resume has no equivalent of the manual-advance ledger comment; the log line + six labels + next monitor poll are the audit trail.)

## Log Line Format

Happy path:

```
resumed <owner>/<repo>#<n>: re-armed phase=<phase> via preceding-gate=<preceding-gate>; added=[<a>,<b>,<c>] removed=[<x>[,<y>[,<z>]]]
```

- `added` is always the same 3-element list in fixed order: `waiting-for:<preceding-gate>`, `completed:<preceding-gate>`, `agent:paused`.
- `removed` contains 1 to 3 labels: `failed:<phase>` always, plus `agent:error` and/or `phase:<phase>` only when they were present pre-mutation.

No-op path:

```
issue <owner>/<repo>#<n> is not in a failed state (no failed:<phase> label); nothing to re-arm
```

Refusal paths (stderr):

```
Error: cockpit resume: <one of the four evidence lines above>
```

## Examples

**Happy path** — recover a `failed:validate` speckit-feature issue:

```
$ generacy cockpit resume generacy-ai/generacy#42
resumed generacy-ai/generacy#42: re-armed phase=validate via preceding-gate=implementation-review; added=[waiting-for:implementation-review,completed:implementation-review,agent:paused] removed=[failed:validate,agent:error]
```

**Bare-number ref in a checkout**:

```
$ cd ~/code/generacy && generacy cockpit resume 42
resumed generacy-ai/generacy#42: re-armed phase=validate via preceding-gate=implementation-review; ...
```

**No-op on a non-failed issue** (exit 0):

```
$ generacy cockpit resume generacy-ai/generacy#41
issue generacy-ai/generacy#41 is not in a failed state (no failed:<phase> label); nothing to re-arm
```

**Refusal on `failed:specify`** (exit 3):

```
$ generacy cockpit resume generacy-ai/generacy#43
Error: cockpit resume: phase "specify" has no preceding gate; use `process:speckit-feature` label to re-queue from the beginning instead
```

**Refusal on multiple failed labels** (exit 3):

```
$ generacy cockpit resume generacy-ai/generacy#44
Error: cockpit resume: multiple failed:* labels present: [failed:tasks, failed:validate]
```

## Idempotency Contract

Running `resume` twice on the same issue in immediate succession:

1. First run: happy path. Log line reports six mutations (assuming worst case).
2. Second run (before the monitor picks up the first): the failed set is already gone, so the classifier takes the **no-op branch** ("issue X is not in a failed state"). Zero mutations.

If the second run occurs AFTER the monitor picked up the first (so `waiting-for:<preceding-gate>` was cleared by `LabelManager.onResumeStart`): the classifier again takes the no-op branch (`failed:<phase>` is gone). Zero mutations.

The verb is thus safe to run in scripts or by mistake.

## Non-goals in v1

- No `--force` flag on the refusal path (parity with `advance`).
- No `--dry-run` flag. If dry-run becomes valuable for scripted callers, follow-up spec.
- No batch mode (`resume <ref1> <ref2>`). Single issue only.
- No comment posted to the issue. The `--comment` opt-in (parity with `advance`) is a follow-up.
