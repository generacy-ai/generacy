# Feature Specification: ## Problem

The four bootstrap-mode PRs that just landed *describe* an end-to-end flow but **miss one integration point**

**Branch**: `562-problem-four-bootstrap-mode` | **Date**: 2026-05-10 | **Status**: Draft

## Summary

## Problem

The four bootstrap-mode PRs that just landed *describe* an end-to-end flow but **miss one integration point**. End-to-end onboarding still doesn't work despite every piece appearing complete.

## The intended flow

```
Wizard ReadyStep
   │ POST /lifecycle/bootstrap-complete         (generacy-cloud#532)
   ▼
Cloud lifecycle endpoint
   │ validateBootstrapComplete (Firestore checks)
   │ requestRouter.routeRequest → /control-plane/lifecycle/bootstrap-complete
   ▼
Cluster control-plane (in-cluster Unix socket)
   │ handlePostLifecycle, parsed.data === 'bootstrap-complete'   ◄── MISSING
   │ writeFile('/tmp/generacy-bootstrap-complete', '')
   ▼
post-activation-watcher.sh (cluster-base#22)
   │ Detects sentinel, fires entrypoint-post-activation.sh
   ▼
setup-credentials + resolve-workspace clone + generacy setup workspace/build
```

The control-plane node in this graph is the gap. Every other node exists; this one was assumed.

## Evidence

**cluster-base's post-activation-watcher.sh** explicitly documents the contract it expects:
> "control-plane bootstrap-complete handler (generacy-cloud#532) writes the sentinel after persisting credentials" — [post-activation-watcher.sh](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/scripts/post-activation-watcher.sh)

(The reference to #532 is slightly misleading — the wizard-side cloud PR (#532) only fires the signal; the *cluster-side* control-plane handler that creates the sentinel is the responsibility of *this* repo, which is what's missing.)

**Cloud-side `lifecycle.ts:165-172`** forwards the literal action string:

```ts
const response = await config.requestRouter.routeRequest(
  clusterId,
  'POST',
  `/control-plane/lifecycle/${action}`,
  ...
);
```

→ When action is `bootstrap-complete`, URL is `/control-plane/lifecycle/bootstrap-complete`.

**Control-plane router** matches the pattern `/^\/lifecycle\/([^/]+)$/` and extracts `action='bootstrap-complete'`. Then:

**Control-plane `routes/lifecycle.ts:18-22`** runs Zod parse against `LifecycleActionSchema`:

```ts
const parsed = LifecycleActionSchema.safeParse(action);
if (!parsed.success) {
  throw new ControlPlaneError('UNKNOWN_ACTION', `Unknown lifecycle action: ${action}`);
}
```

**`LifecycleActionSchema` enum** (`packages/control-plane/src/schemas.ts:39-45`):

```ts
export const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'set-default-role',
  'code-server-start',
  'code-server-stop',
  'stop',
]);
```

`'bootstrap-complete'` is not in the enum → Zod rejects → ControlPlaneError → 4xx response → sentinel never written → watcher never fires → cluster stuck.

## Reproduction

1. Complete v1.5 onboarding through the wizard's ReadyStep.
2. Watch network: POST `/lifecycle/bootstrap-complete` to cloud returns 200 (cloud-side success — it forwarded).
3. Cluster's control-plane log shows the rejection ("Unknown lifecycle action: bootstrap-complete").
4. `docker compose exec orchestrator ls -la /tmp/generacy-bootstrap-complete` — file does not exist.
5. Workspace is empty; `git clone` never happened; cluster is stuck in "Ready according to wizard, not actually ready" state.

Manual workaround for testing right now: `docker compose exec orchestrator touch /tmp/generacy-bootstrap-complete`. The watcher then fires correctly and the post-activation flow completes. This confirms the rest of the chain works — only the sentinel write is missing.

## Fix

Two-part patch in `packages/control-plane/src/`:

**`schemas.ts`** — add to the enum:

```diff
 export const LifecycleActionSchema = z.enum([
   'clone-peer-repos',
   'set-default-role',
   'code-server-start',
   'code-server-stop',
+  'bootstrap-complete',
   'stop',
 ]);
```

**`routes/lifecycle.ts`** — add a handler branch:

```ts
if (parsed.data === 'bootstrap-complete') {
  const sentinel = process.env.POST_ACTIVATION_TRIGGER ?? '/tmp/generacy-bootstrap-complete';
  await fs.promises.writeFile(sentinel, '', { flag: 'w' });
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, action: parsed.data, sentinel }));
  return;
}
```

Design notes:

- **Path source**: respect `POST_ACTIVATION_TRIGGER` env var (matches watcher.sh's contract); default `/tmp/generacy-bootstrap-complete` (matches the documented default).
- **Idempotent**: `flag: 'w'` overwrites; touch-on-existing-file is harmless. Matches the watcher script's idempotency contract.
- **Body**: empty content — the watcher only checks for *existence*, not content. Could be extended later to write a timestamp for diagnostics, but unnecessary now.
- **Permissions**: file is created with the orchestrator container's umask (usually 0022 → 0644). Watcher reads as the same uid → fine.

## Test plan

- [ ] Add a test in `packages/control-plane/src/routes/__tests__/lifecycle.test.ts` (or wherever lifecycle tests live) that:
  - POSTs `/lifecycle/bootstrap-complete`
  - Asserts 200 response
  - Asserts the sentinel file exists at the expected path (mockable via `POST_ACTIVATION_TRIGGER`)
- [ ] Add an `'bootstrap-complete'` case to existing LifecycleActionSchema enum tests if any exist
- [ ] After deploy: complete the wizard end-to-end on staging, verify the cluster's `/tmp/generacy-bootstrap-complete` appears, post-activation script runs, repo gets cloned

## Related

- #558 — control-plane PUT /credentials/:credentialId handler (orthogonal, also merged; that's the *credential write* path; this is the *signal* path)
- generacy-ai/generacy-cloud#532 — wizard-side ReadyStep call (merged; works correctly, but its target on the cluster side returns 4xx until this issue lands)
- generacy-ai/cluster-base#22 — post-activation hook / sentinel watcher (merged; works correctly once something writes the sentinel)
- This is the missing fourth piece. After it lands, v1.5 onboarding works end-to-end for the first time.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
