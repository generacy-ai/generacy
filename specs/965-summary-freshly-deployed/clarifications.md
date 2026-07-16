# Clarifications

## Batch 1 — 2026-07-16

### Q1: Redirect status acceptance policy
**Context**: FR-002 states two non-equivalent formulations: the explicit set `{301, 302, 307, 308}` **or equivalently** the range `>= 300 && < 400`. These are not actually equivalent — the broad range also matches `303 See Other`, `304 Not Modified`, `305 Use Proxy`, and `306`. Implementation must pick one. This affects the guard in `provision()` at `smee-channel-resolver.ts:141`.
**Question**: Which acceptance predicate should `provision()` use for the response status?
**Options**:
- A: Explicit set membership: `[301, 302, 307, 308].includes(response.status)` — strict, ignores `303`/`304`/`305`/`306`.
- B: Broad 3xx range: `response.status >= 300 && response.status < 400` — accepts any redirect-family status, hedges against another silent upstream flip.
- C: Explicit set widened to include `303`: `[301, 302, 303, 307, 308]` — matches practical HTTP redirect vocabulary while excluding `304`/`305`/`306`.

**Answer**: *Pending*

### Q2: HTTP method — GET or HEAD
**Context**: FR-001 permits `GET` **or** `HEAD` against `https://smee.io/new`. Both are verified to return `307` with a valid `Location` today. `HEAD` avoids transferring a response body (marginally cheaper, more principled since we only need the `Location` header). `GET` matches typical curl-in-terminal debugging and is less likely to be broken by an intermediary that drops `HEAD` support. Only one is implemented.
**Question**: Which HTTP method should `provision()` issue?
**Options**:
- A: `GET` — matches manual debugging invocations, universally supported.
- B: `HEAD` — no body transferred, semantically closer to "just tell me the redirect target".

**Answer**: *Pending*

### Q3: FR-007 error message improvement — in scope or deferred
**Context**: FR-007 is marked P2 ("Nice-to-have, not blocking") and would change the error string from `"unexpected status 200"` to something like `"expected 3xx with Location, got 200"`. Including it means editing the same lines this bugfix already touches (essentially free); deferring keeps this PR minimal and lets the wording be revisited separately. The current wording will remain diagnostic ("unexpected status 200") if deferred.
**Question**: Should FR-007's error message wording change ship as part of this bugfix PR?
**Options**:
- A: Ship in this PR — the lines are already being edited; incremental cost is near zero.
- B: Defer to a follow-up — keep this PR tightly scoped to method + status-acceptance only.

**Answer**: *Pending*
