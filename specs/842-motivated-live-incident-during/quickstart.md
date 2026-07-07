# Quickstart: Author-trust gating for workflow-ingested GitHub comments

**Issue**: [#842](https://github.com/generacy-ai/generacy/issues/842)
**Plan**: [plan.md](./plan.md)

## What this changes

Comments on your workflow-managed issues and PRs are now filtered by the author's `author_association` before agents ingest them. Comments from external accounts (`NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, and by default `CONTRIBUTOR`) are excluded from clarify answer-parsing, clarify resume prompts, and PR-feedback prompts.

The cluster's own bot identity is always trusted regardless of tier.

## Default behavior (no config required)

- **Trusted by default**: `OWNER`, `MEMBER`, `COLLABORATOR`, and your cluster's bot login.
- **Untrusted by default**: everyone else, including `CONTRIBUTOR` (one merged PR).
- **Skips are logged** structurally at `info` level (`event: comment-skipped`, with author + tier metadata; never the comment body).
- **`Q<N>:` answer-pattern skips also post a bot comment** on the issue naming the untrusted author + tier, so the repo owner can see why a visible GitHub answer was ignored.

No action needed to enable — the change ships with the default posture on.

## Widening trust for a repo (optional)

Create `.agency/comment-trust.yaml` at the workspace root:

```yaml
# Widen the allowlist for CONTEXT surfaces (clarify-resume, pr-feedback).
# The clarify answer-scanner is ALWAYS pinned to OWNER/MEMBER/COLLABORATOR + bot.
widen:
  tiers:
    - CONTRIBUTOR       # Trust past-merged-PR authors on context surfaces
  logins:
    - external-triage-bot
    - alice
```

- **`widen.tiers`**: additive to the default `[OWNER, MEMBER, COLLABORATOR]`. Common value: `CONTRIBUTOR` (for open-source projects that triage external contributions).
- **`widen.logins`**: specific GitHub logins to trust on context surfaces regardless of tier.
- **Scope**: widen applies **only** to the `clarify-resume` and `pr-feedback` surfaces. The `clarify answer-scanner` — which deterministically writes into `spec.md` via parsed `Q<N>:` answers — is pinned to the hard default and ignores this config.
- **Missing / malformed file**: default posture, no error.
- **`OWNER`/`MEMBER`/`COLLABORATOR` cannot be removed** — the config is widen-only.

## Verifying which comments are being skipped

Check cluster logs for structured lines with `event: comment-skipped`:

```json
{"event":"comment-skipped","surface":"clarify-resume","commentId":12345,"author":"drive-by","authorAssociation":"NONE","reason":"none-untrusted"}
```

For `answer-scanner` skips that matched the `Q<N>:` pattern, look on the issue itself — the bot will have posted:

> Answers from @drive-by were not applied (association tier: `NONE`). A trusted member (OWNER/MEMBER/COLLABORATOR) must post or confirm the answers.

## Available commands / entry points

This is a library-level change; no new CLI commands.

Surfaces that changed:
- `speckit:clarify` (both initial and resume paths)
- `speckit:address-pr-feedback`
- All phase prompts that ingest issue/PR-thread content are now wrapped in an `<untrusted-data>` fence.

## Troubleshooting

**"My legitimate collaborator's `Q1: A` answer was skipped."**
Check the issue for the bot explainer comment; it will name the tier. The most common cause is a collaborator who is not in the repo's Members/Collaborators list on GitHub — their association resolves to `CONTRIBUTOR` or `NONE`. Two options:

1. Add them as a Collaborator on GitHub (permanent, cross-repo per-org policy).
2. Widen the context config to trust their login (`.agency/comment-trust.yaml` → `widen.logins: [<login>]`) — but note this does NOT help the answer-scanner. For the answer-scanner, an OWNER/MEMBER/COLLABORATOR must post or confirm the answers.

**"The bot's own comment was skipped."**
This means the cluster's bot identity couldn't be resolved. Check the orchestrator startup logs for the warning `Assignee filtering disabled: no cluster identity configured` — same chain resolves both. Fix by setting `CLUSTER_GITHUB_USERNAME` in the cluster config or ensuring `GH_USERNAME` is populated by the wizard credential-env-writer.

**"I'm seeing a `warn` log about an unrecognized author_association tier."**
GitHub added a new enum value. Verified fail-safe: the comment was treated as untrusted. Update `packages/workflow-engine/src/security/comment-trust.ts` (the `KNOWN_UNTRUSTED_TIERS` / `DEFAULT_TRUSTED_TIERS` sets) to categorize the new tier deliberately and ship a patch.

**"My widen-config isn't being applied."**
Verify the file is at `<workspaceDir>/.agency/comment-trust.yaml` (not `.agency/comment-trust.yml`, not repo-root). Verify the top-level key is `widen:` (Zod `.strict()` rejects typos like `wide:` silently). If the file is malformed, a warn log names the failed field.

**"I need to widen trust for the answer-scanner too."**
Not supported by design — the answer-scanner deterministically writes into `spec.md`. The recommended path is to add the person as a Collaborator on GitHub. If that is genuinely not possible, an OWNER/MEMBER/COLLABORATOR must post the answers (or copy/paste them) instead.

## Testing locally

1. Run the trust-helper unit tests:

   ```bash
   cd packages/workflow-engine
   pnpm test src/security/__tests__/comment-trust.test.ts
   ```

2. Run the ingestion-surface integration tests:

   ```bash
   pnpm -w test comment-trust
   ```

3. Grep audit (SC-002 — zero unfiltered call sites):

   ```bash
   # Every hit MUST be adjacent to an isTrustedCommentAuthor call
   # OR carry an explicit whitelist comment naming the reason
   rg -n "getIssueComments|getPRComments|--comments" packages/
   ```

## Related

- Bot identity resolution: `packages/orchestrator/src/services/identity.ts` (#830)
- Prior bot-question filter: `isQuestionComment` in `clarification-poster.ts` (PR #818)
- Incident that triggered this: `cockpit_fix_v3.zip` drive-by on issue #839 (2026-07-07)
