# Contract: `webhookToStreamEvent`

Pure function. Maps a normalized GitHub webhook payload to zero or one
`CockpitStreamEvent`. Q1=A: preserves the existing event enum; no schema
change to `CockpitEventSchema`.

## Signature

```ts
export function webhookToStreamEvent(
  githubEvent: string,
  action: string,
  body: Record<string, unknown>,
  refSet: RefSetView,
  now: () => string,               // returns ISO-8601 timestamp
): CockpitStreamEvent | null;
```

## Mapping table (Q1=A)

Returns `null` unless a row matches AND the payload's ref appears in the
`refSet`. `null` is the "drop this payload silently" signal.

| `githubEvent` | `action` | additional discriminator | ref filter | emitted `event.event` | notes |
|---|---|---|---|---|---|
| `issues` | `labeled` | `label.name` present | issue in `refSet.issues` | `label-change` | `from`/`to` best-effort from `issue.labels[]` snapshot |
| `issues` | `unlabeled` | `label.name` present | issue in `refSet.issues` | `label-change` | same |
| `issues` | `closed` | — | issue in `refSet.issues` | `issue-closed` | |
| `issues` | `opened`, `reopened`, `edited`, `assigned`, `unassigned`, ... | — | any | `null` | out of scope |
| `pull_request` | `closed` | `pull_request.merged === true` | pr in `refSet.prs` | `pr-merged` | |
| `pull_request` | `closed` | `pull_request.merged === false` | pr in `refSet.prs` | `pr-closed` | |
| `pull_request` | `opened`, `reopened`, `synchronize`, `ready_for_review`, ... | — | any | `null` | out of scope |
| `check_run` | `completed` | — | any PR in `check_run.pull_requests[*].number` present in `refSet.prs` | `pr-checks` | one event per matched PR; deduped in caller if multiple |
| `check_suite` | `completed` | — | any PR in `check_suite.pull_requests[*].number` present in `refSet.prs` | `pr-checks` | |
| `pull_request_review` | any | — | any | `null` | **out of scope — Q1=A** |
| `pull_request_review_comment` | any | — | any | `null` | **out of scope — Q1=A** |
| `issue_comment` | any | — | any | `null` | **out of scope — Q1=A** |
| `push`, `ping`, `workflow_run`, ... | any | — | any | `null` | out of scope |

## Ref extraction

- `issues.*`: `owner=body.repository.owner.login`,
  `repo=body.repository.name`, `number=body.issue.number`.
  Key: `${owner}/${repo}#${number}`.
- `pull_request.*`: same but `number=body.pull_request.number`.
- `check_run.*`: iterate `body.check_run.pull_requests[*]`; for each
  `pr` extract `pr.number` and (via `body.repository`) form the key.
- `check_suite.*`: iterate `body.check_suite.pull_requests[*]`.

## Emitted `CockpitEventValidated` shape

Matches `CockpitEventSchema` in
`packages/generacy/src/cli/commands/cockpit/watch/emit.ts`:

```ts
{
  type: 'issue-transition',
  ts: now(),                     // ISO-8601
  repo: `${owner}/${repo}`,
  kind: 'issue' | 'pr',
  number,
  from: null,                    // best-effort — the SSE-mode line consumers use only `event.type`
  to: null,                      // best-effort — same
  sourceLabel: label?.name ?? null,
  url: `https://github.com/${owner}/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
  event: 'label-change' | 'issue-closed' | 'pr-merged' | 'pr-closed' | 'pr-checks',
  labels: (issue.labels ?? []).map(l => l.name),
}
```

**Why `from`/`to` are `null`**: The doorbell stdout line is `event.type\n`
(`lineForEvent`). Skill consumers use only `event.type`. Authoritative
`from`/`to` diffs remain the responsibility of `cockpit_await_events` on the
poll bus, which the smee source deliberately does not touch (FR-007).

## Determinism

Given the same inputs, `webhookToStreamEvent` returns the same output. `now`
is injected for testability.

## Test cases

- `issues.labeled` with `refSet.issues` match → returns `event.event ===
  'label-change'`.
- `issues.labeled` with ref not in `refSet` → returns `null`.
- `pull_request.closed` with `pull_request.merged === true` → `event.event ===
  'pr-merged'`.
- `pull_request.closed` with `pull_request.merged === false` → `event.event ===
  'pr-closed'`.
- `check_run.completed` with `pull_requests: [{ number: 5 }]` where
  `owner/repo#5 ∈ refSet.prs` → one `pr-checks` event.
- `pull_request_review.submitted` → `null`.
- `issue_comment.created` → `null`.
- `unknown.event` → `null`.
- `issues.labeled` on a repo NOT in `refSet.watchedRepos` → `null` (coarse
  pre-filter).
