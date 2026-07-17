# Quickstart: Same-account clarification answers (#976)

## What changed for operators

- Plain-text `Q<n>: <answer>` replies posted from the **cluster's own GitHub account** now auto-resume and integrate, just like a reply from any other trusted account. No marker required, no `completed:clarification` needed, no config flag.
- Cluster machine comments (question posts, stage/status comments, audit comments, explainer comments) continue to be ignored by the answer scanner — that safety is now enforced by a broader marker set instead of the "same account = ignore" identity gate.

## The primary flow, before vs. after

**Before (#958 behavior — the bug):**

1. Cluster runs under `christrudelpw` credentials.
2. Operator (same account, human) posts:
   ```
   Q1: A
   Q2: B
   Q3: B
   ```
3. Nothing happens. Auto-resume monitor skips the comment because `viewerDidAuthor === true`. Even if the operator manually adds `completed:clarification` to force-resume, the phase-loop scanner drops the same comment for the same reason. `clarifications.md` stays `**Answer**: *Pending*`, the phase re-arms `waiting-for:clarification`, silent loop.
4. Only workaround: MCP `cockpit_relay_clarify_answers` (marker-stamped).

**After (#976 behavior):**

1. Same setup.
2. Operator posts the same plain-text reply.
3. Auto-resume monitor enqueues within one poll cycle (default 60 s). Phase loop resumes, integrates the answers into `clarifications.md`, advances the gate. No manual intervention.

## What operators should NOT notice

- No CLI flag changes.
- No config-file changes.
- No new labels applied to issues.
- No NDJSON output changes for `cockpit watch`.
- No MCP schema changes.
- Different-account human answers (a teammate, a code reviewer, a maintainer) — unchanged, still integrate exactly as under #958.
- Trusted-author gating (OWNER / MEMBER / COLLABORATOR) — unchanged; drive-by comments from untrusted accounts still get the `<!-- generacy-untrusted-answer: -->` explainer bot comment.

## How to verify the fix is active

On an issue at `waiting-for:clarification` + `agent:paused`, from an account matching the cluster's login:

1. Post a plain-text reply following the question numbering:
   ```
   Q1: OAuth 2.0
   Q2: JWT
   Q3: Rate limited to 100/min
   ```
2. Wait up to one poll interval (default 60 s).
3. Check the issue timeline — you should see `agent:paused` removed and the phase advance. `clarifications.md` on the branch should show your answers filled in.

If the issue stays paused past the poll interval, check cluster logs for:

- `Clarification-answer resume enqueued` — monitor picked up your comment (good).
- `Integrated GitHub answers into clarifications.md` — phase loop integrated (good).
- `Excluded from answer-scanner via machine marker` with `markerPrefix` — your comment matched a machine marker. If unexpected, verify your comment body doesn't start with `<!-- generacy-...` at column 0.

## Deprecated: `cockpit_relay_clarify_answers`

The MCP tool that stamps `<!-- generacy-clarification-answers: -->` markers on relayed answer comments is no longer needed. The tool itself is not deleted in this release (external consumers may still call it), but its posted comments are now excluded by the answer scanner — the tool becomes a no-op on the integration side.

**Migration**: post plain-text `Q<n>: <answer>` comments directly. No marker, no wrapper. Integration happens through the normal flow.

Follow-up work: emit a stderr deprecation warning from the tool, or auto-post a marker-free companion body. Tracked separately.

## Known limitations

- **Same-account bot identities still work.** The fix has no identity classification. A cluster login ending in `[bot]` posts a plain `Q1: ...` comment → integrated. This is fine — the alternative was silently dropping human answers, and the machine-marker gate protects against the cluster's own machinery mis-integrating its own comments.
- **Cluster-side out-of-band commit messages don't integrate.** The answer scanner only reads GitHub issue comments. A commit message that says `Q1: OAuth` doesn't integrate. (Same behavior as before this fix.)
- **Parse failures still don't produce a label.** Q3=A explicitly declined a `needs-attention:clarification-rejected` label. Failures surface as either a `<!-- generacy-clarification-parse-failures: -->` explainer comment on the issue or as a warn-level cluster log line. If you want a label-level signal, that's a follow-up feature request.

## Rollback

The change is a pure code diff; rollback = revert the PR. No migration, no persisted state, no cluster restart choreography.

Per-cluster kill switch is NOT provided — the fix has no config surface (Q1=A). If a rollout regresses a specific cluster, revert and file a bug.

## Troubleshooting

**"My same-account plain reply didn't integrate."**

1. Confirm the comment body does not accidentally start with `<!-- generacy-...` (a common paste mistake if you copied from a machine comment above).
2. Confirm the issue is currently `waiting-for:clarification` + `agent:paused` (monitor won't enqueue otherwise).
3. Confirm no `blocked:*` label is present (monitor skips blocked issues).
4. Check cluster logs for `Excluded from answer-scanner via machine marker` — if present, your comment matched an unexpected marker. Include the log's `markerPrefix` field when reporting.

**"Marker-relay comments stopped working after upgrade."**

Expected. Post plain-text `Q<n>: <answer>` instead. If you have automation that generates marker-stamped comments, update it to skip the marker wrapper.

**"A teammate's answer from a different account still works, right?"**

Yes. This change only removes an identity-based gate that was over-restrictive for same-account operators. Different-account trusted-author paths (OWNER / MEMBER / COLLABORATOR) are unchanged.
