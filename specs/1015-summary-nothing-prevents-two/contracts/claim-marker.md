# Claim Marker Grammar

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

## Storage medium

A dedicated comment on the scope issue. The comment body contains **only** the marker (no additional prose) so `editIssueComment` can overwrite the whole body safely.

## Body format (verbatim)

```
<!-- cockpit:claim v1 -->
```json
{
  "version": 1,
  "sessionId": "<16-64 hex chars>",
  "heldSince": "<ISO-8601 UTC>",
  "heartbeatAt": "<ISO-8601 UTC>",
  "ledger": "<relative-path>",
  "scope": "<owner>/<repo>#<n>"
}
```
```

Note: the outer triple-backtick fence around the entire block is only for this documentation. The actual comment body is literally:

- Line 1: `<!-- cockpit:claim v1 -->`
- Line 2: ```` ```json ```` (fenced-JSON opener)
- Lines 3-N: the JSON object (2-space indent)
- Line N+1: ```` ``` ```` (fenced-JSON closer)

## Detection

A comment is a claim marker iff:

1. Its `body` (trimmed of trailing whitespace only, not leading) **starts with** the exact string:
   ```
   <!-- cockpit:claim v1 -->
   ```
   (case-sensitive, no variation in whitespace)

2. Its body contains a ```` ```json ```` … ```` ``` ```` fenced block.

3. The fenced block parses as JSON.

4. The parsed JSON validates against `ClaimPayloadSchema`.

Any of (1)-(4) failing → the comment is not a valid marker and is skipped during discovery (silently), except that malformed-but-marker-prefixed comments (matched (1) but failed (2)-(4)) MAY be deleted as best-effort cleanup during discovery.

## Version handling

- v1 is the current version.
- Future v2+ would use a distinct prefix (`<!-- cockpit:claim v2 -->`) and be handled by a separate parser branch. Both parsers run during discovery; a v2 marker on a v1-only build is ignored (not deleted) so a rollback doesn't destroy live claims from a newer build.
- `version: 1` inside the JSON is redundant with the prefix but serves as a belt-and-braces check — a mismatched inner version is a parse failure.

## Uniqueness invariant

A scope has ≤1 live claim marker at any moment. This is enforced by discovery's oldest-wins tiebreaker + delete-younger step (see `research.md` R-9). Callers do not need to check for duplicates; discovery handles it.

## Life cycle

- **Created** by `cockpit_claim` action `acquired` or `taken-over` (via `postIssueComment`).
- **Updated** by `cockpit_claim` action `refreshed` (via `editIssueComment`, in-place body replacement).
- **Deleted** by `cockpit_release` action `released` (via `deleteIssueComment`).
- **Deleted** by `cockpit_claim` when it discovers a stale marker (heartbeatAt > 10 min old) or a duplicate marker during acquire re-verify (best-effort; failure to delete does not fail the caller's operation).
- **Never edited by hand** — operators inspecting the marker for debugging should not modify it. If a marker's JSON is manually corrupted, the next `cockpit_claim` call will treat it as stale and delete it.

## Rendered appearance

In GitHub's issue UI, the comment renders as an empty HTML-comment block followed by a fenced JSON code block. Operators inspecting the issue see a small JSON payload; the HTML comment is invisible in the rendered view but visible in "raw" view.

## Namespace collision check

The `cockpit:claim` prefix does not collide with any existing marker used in this repo:

| Marker prefix                          | Owner                                                                 |
|----------------------------------------|-----------------------------------------------------------------------|
| `<!-- cockpit:answers v1 -->`          | `cockpit_relay_clarify_answers` (existing)                            |
| `<!-- speckit-clarify-answer -->`      | (external speckit tooling)                                            |
| `<!-- cockpit:claim v1 -->`            | This feature (new)                                                    |

Verified via `grep -r "cockpit:" packages/ | grep -v test` — the `cockpit:` label/marker prefix is a new namespace introduced together with this feature and `cockpit_relay_clarify_answers`.
