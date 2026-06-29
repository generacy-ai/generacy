# Clarifications: Cockpit `resolveEpicIssues` honors cross-repo epic children

**Issue**: [generacy-ai/generacy#801](https://github.com/generacy-ai/generacy/issues/801)

## Batch 1 — 2026-06-29

### Q1: Return type shape
**Context**: FR-001 says `Array<{ repo: string; number: number }>` "or equivalent `owner/repo#n` strings". Downstream callers (`status.ts`, `watch.ts`, `shared/scoping.ts`'s `Scope.issues`) need a single agreed shape before they can be rewritten. The choice ripples into the public API exported from `@generacy-ai/cockpit` (FR-007).
**Question**: Which exact return shape should `resolveEpicIssues` produce?
**Options**:
- A: `Array<{ repo: string; number: number }>` (typed object, `repo` is full `owner/repo`)
- B: `Array<string>` of `owner/repo#n` (matches manifest wire format, callers must parse)
- C: `Array<{ owner: string; repo: string; number: number }>` (split owner/repo)

**Answer**: *Pending*

---

### Q2: Role of `phases[].repos` in manifest-path resolution
**Context**: The spec summary highlights that the manifest schema supports both `phases[].issues` AND `phases[].repos`. Today `resolveEpicIssues` reads only `phases[].issues`. `phases[].repos` is validated by the schema but unused. For a fix that explicitly aims at cross-repo correctness, the role (or non-role) of `phases[].repos` should be pinned.
**Question**: Should `phases[].repos` participate in resolution?
**Options**:
- A: Keep ignoring it — resolution stays `phases[].issues`-only; `phases[].repos` remains informational.
- B: Use as fallback scope hint — when `phases[].issues` is empty for a phase, search `phases[].repos` for `epic-child` label / body refs to the epic.
- C: Always union — for every phase, also search `phases[].repos` and union with the listed `issues`.

**Answer**: *Pending*

---

### Q3: Fallback scope — which repos get searched
**Context**: FR-004 says iterate `cockpit.repos`; FR-005 says fall back to the epic's own repo when no `repos` is configured. Open question: when `cockpit.repos` IS configured, should the epic's own repo be implicitly included (even if absent from `cockpit.repos`)? This matters for under-configured cockpits where a user forgot to list the epic's home repo.
**Question**: When `cockpit.repos` is configured, what's searched?
**Options**:
- A: `cockpit.repos ∪ epic's own repo` (deduped) — defensive against under-configured cockpits.
- B: Strictly `cockpit.repos` — epic's own repo only searched if it's listed there. No implicit add.
- C: `cockpit.repos` if non-empty, else epic's own repo (matches FR-005 wording literally; FR-004 stays as "iterate `cockpit.repos`" without implicit add).

**Answer**: *Pending*

---

### Q4: Fallback per-repo query construction
**Context**: Today's fallback uses two `gh search` queries scoped to the epic's own repo: a label-based (`label:epic-child #<epicN>`) and a body-ref (`<ownerRepo>#<epicN> in:body`). When the search is rebroadcast across `cockpit.repos`, both queries need a repo substitution AND the epic reference needs to remain fully qualified (since the search is happening in a non-epic-home repo). The label query also becomes less reliable across repos because `epic-child` doesn't disambiguate which epic.
**Question**: What's the per-repo query construction?
**Options**:
- A: Both queries, full epic ref — per repo R: `repo:R is:issue label:epic-child <epicOwner/epicRepo>#<epicN>` AND `repo:R is:issue <epicOwner/epicRepo>#<epicN> in:body`. Two queries per repo.
- B: Body-only, full epic ref — drop label query in fallback (label alone is ambiguous when searching across repos); per repo R only `repo:R is:issue <epicOwner/epicRepo>#<epicN> in:body`.
- C: Both queries, short form — per repo R: keep `#<epicN>` short form (`label:epic-child #<epicN>` and `#<epicN> in:body`). Risk: `#N` matches unrelated issues with the same number in other repos.

**Answer**: *Pending*

---

### Q5: Semver bump for `@generacy-ai/cockpit`
**Context**: FR-001 explicitly calls the return-type change "breaking". FR-007 says "bump cockpit package minor version". These are inconsistent under strict semver — though the repo may treat pre-1.0 packages as allowing breaking changes in minor bumps.
**Question**: Which version bump should `@generacy-ai/cockpit` get?
**Options**:
- A: Minor (0.x.0) — treat as pre-1.0; FR-007 stays as written.
- B: Major — honor breaking-change semantics; update FR-007 to "bump major".
- C: Patch — treat as bugfix to a contract that never correctly supported cross-repo; minimal bump.

**Answer**: *Pending*
