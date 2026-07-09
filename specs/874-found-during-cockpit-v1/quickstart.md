# Quickstart: verify acting-identity resolution locally

## Prerequisites

- Existing local Generacy scaffolded cluster (`~/Generacy/<projectName>/.generacy/`) OR ability to run `generacy launch --claim=<code>` to scaffold a fresh one.
- Docker + Compose v2.
- The App-bot login of your workspace's installed GitHub App. Example: `generacy-ai`.

## 1. Scaffold with the acting login set

### Fresh cluster (post-#874)

`generacy launch` will pull `actingLogin` from `LaunchConfig` once generacy-cloud ships its half. Until then, hand-edit the generated `.env`:

```bash
generacy launch --claim=<code>
cd ~/Generacy/<projectName>/.generacy
# Add the acting login to .env (order matters for readability; place under GENERACY_ORG_ID)
sed -i '/^GENERACY_ORG_ID=/a CLUSTER_ACTING_LOGIN=generacy-ai' .env
```

### Existing cluster (upgrade path)

The variable is **not** back-filled by container restart alone. Add it to `.env` and restart:

```bash
cd ~/Generacy/<projectName>/.generacy
sed -i '/^GENERACY_ORG_ID=/a CLUSTER_ACTING_LOGIN=generacy-ai' .env
docker compose up -d
```

## 2. Verify the resolver

Watch the boot logs:

```bash
docker compose logs -f orchestrator | grep -i 'acting identity'
```

Expected line on success:

```
{"level":"info","actingLogin":"generacy-ai","source":"env","msg":"Acting identity resolved: generacy-ai (from CLUSTER_ACTING_LOGIN)"}
```

If you left the var unset, expected line on failure:

```
{"level":"error","triedChain":["CLUSTER_ACTING_LOGIN"],"outcome":"unset-or-empty","msg":"Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai)."}
```

Exactly one such line per boot — never repeated.

## 3. Verify the trust rule fires

1. Pick an active PR in your cluster's watched repo. Have the cockpit request-changes on it (`/cockpit:review …#N --gate implementation-review`, select request-changes).
2. Wait one poll cycle (default 10s). Grep the orchestrator log for the trust decision:

```bash
docker compose logs orchestrator | tail -100 | grep -E 'reason.*cluster-identity|untrustedCommentSkips'
```

Expected: `reason: cluster-identity` on the entries authored by the App bot; no `untrustedCommentSkips` warn line for that PR.

## 4. Verify the degraded-mode observability

1. Remove `CLUSTER_ACTING_LOGIN` from `.env` and restart:
   ```bash
   sed -i '/^CLUSTER_ACTING_LOGIN=/d' .env
   docker compose up -d
   ```
2. Wait for the boot line described in §2 (`error`-level, exactly one).
3. Repeat step 3. This time the trust rule does not fire — expect the `untrustedCommentSkips` warn line.
4. Grep the warn shape (FR-005 extension):
   ```bash
   docker compose logs orchestrator | grep 'PR has unresolved threads but every comment author is untrusted' | tail -1 | jq
   ```
   Expected top-level `clusterIdentity: null`, `normalizedClusterIdentity: null`. Each entry in `untrustedCommentSkips` contains `normalizedAuthor` alongside the raw `author`.

## 5. Verify the case/whitespace/[bot]-suffix matrix

Manual variants (each requires a stop + edit + up cycle):

```bash
# Case drift
CLUSTER_ACTING_LOGIN=Generacy-AI
# Whitespace drift
CLUSTER_ACTING_LOGIN=  generacy-ai
# [bot] suffix drift
CLUSTER_ACTING_LOGIN=generacy-ai[bot]
```

Every variant must produce the same behavior as the canonical `generacy-ai` — the resolver logs the normalized form, the trust rule fires on App-bot-authored comments. The `contracts/normalize-login.contract.md` fixture matrix codifies the 16 cases. The unit test at `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts` covers them; no need to run all 16 manually.

## 6. Verify the assignee chain is untouched

`filterByAssignee()` still uses `CLUSTER_GITHUB_USERNAME` for issue-assignment gating — this change must not affect that:

```bash
grep 'Cluster identity resolved' <(docker compose logs orchestrator | head -200)
```

You should see two `info` lines at boot:
- One from `resolveClusterIdentity()` (existing, for `filterByAssignee`).
- One from `resolveActingIdentity()` (new, for the trust rule).

The two values are typically different (`christrudelpw` vs `generacy-ai` on a scaffolded cluster).

## Troubleshooting

### The trust rule still doesn't fire after setting `CLUSTER_ACTING_LOGIN`

Check the normalization pair in the skip-warn:

```bash
docker compose logs orchestrator | grep untrustedCommentSkips | tail -1 | jq '.untrustedCommentSkips[0], .normalizedClusterIdentity'
```

If `normalizedAuthor !== normalizedClusterIdentity`, the provisioned value doesn't match the actual App bot. Verify the App slug: on GitHub, navigate to your app's settings page and confirm the URL slug matches the `CLUSTER_ACTING_LOGIN` (without the `[bot]` suffix — normalization strips it anyway).

### The boot error line never appears even though `CLUSTER_ACTING_LOGIN` is unset

Confirm the variable is not being inherited from a shell profile or Docker Compose override. The resolver reads `process.env` inside the container:

```bash
docker compose exec orchestrator env | grep CLUSTER_ACTING_LOGIN
```

If the var is set inside the container (e.g., from a stale `.env.local`), remove it and restart.

### Multiple boot error lines appear

FR-006 mandates exactly one per process. If you see more, the resolver is being called more than once — this is a bug in the wiring. File it against #874's follow-up.
