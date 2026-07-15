# Contract: Failure-Alert Comment Marker v2

**Location**: `packages/orchestrator/src/worker/stage-comment-manager.ts` (MODIFIED — `renderFailureAlert`)

## v1 (pre-#942, byte-preserved on unchanged sites)

Line 1:
```
<!-- generacy:failure-alert:${stage}:${runId} -->
```

Dedup at `stage-comment-manager.ts:346` uses `comments.find((c) => c.body.includes(marker))` where `marker = `<!-- generacy:failure-alert:${stage}:${runId} -->` `. This is a substring check terminated by `-->`.

## v2 (this feature)

Line 1:
```
<!-- generacy:failure-alert:${stage}:${runId} --> <!-- fp:${fingerprint}:${occurrence} -->
```

- **First HTML comment** — unchanged v1 marker. Preserves the `.includes(v1Marker)` dedup path.
- **Space-separated**.
- **Second HTML comment** — 16-char hex fingerprint + `:` + 1-based occurrence count.

Rest of body (summary line, reason block, `<details>`, output fence, `</details>`) is byte-identical to #865/#890/#915.

## Wire example (v2 replay of snappoll#8 alert 2)

```
<!-- generacy:failure-alert:implementation:5e6e1169-6acd-40f8-91a5-1234... --> <!-- fp:9c4d3e2a1b0f8a7b:2 -->
❌ **implement failed** — `implement` failed post-exit: no-product-code-changes (process exit 0).
**Reason**: Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.

<details><summary>output (last 1 lines)</summary>

```text
(no output on either stream)
```

</details>
```

The `:2` occurrence tells the operator this is the second byte-identical failure — the surface signal spec §"Suggested fix" bullet 3 asked for.

## Compatibility

- **v1 comment reader** (any pre-#942 consumer using `.includes('<!-- generacy:failure-alert:')`) — still matches. The additional `<!-- fp:… -->` on the same line does not interrupt the substring.
- **v1 runId dedup** at `stage-comment-manager.ts:346` — still works. The v1 marker substring is intact.
- **v2 reader** (`parseFailureAlertMarker` in this feature) — extracts fingerprint + occurrence from the second HTML comment on line 1.
- **Historical comments** (snappoll#8's actual comments, any pre-#942 issue re-scanned) — return `null` from `parseFailureAlertMarker`; treated as "different fingerprint" (occurrence starts fresh at 1). This is the intended semantics.

## Invariants (asserted in `stage-comment-manager.test.ts`)

- **INV-C1** — First line matches `/^<!-- generacy:failure-alert:[^ ]+ --> <!-- fp:[0-9a-f]{16}:\d+ -->$/`.
- **INV-C2** — There is exactly ONE space between the two markers (not tab, not multiple spaces).
- **INV-C3** — Body lines 2+ are byte-identical to the pre-#942 render output (established by `stage-comment-manager.test.ts` golden strings, updated only for line 1).
