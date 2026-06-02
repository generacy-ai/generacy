# Tasks: Fix `scaffoldDockerCompose` `volume`-mode Claude config mount

**Input**: Design documents from `/specs/737-summary-scaffolddockercompose/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/scaffolder-volume-mode.md, contracts/remote-compose-ownership.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Tests First (lock current behavior, define new behavior)

- [ ] T001 [US2] Add a snapshot/golden test in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` that asserts `claudeConfigMode: 'bind'` output for a representative `ScaffoldComposeInput` is **byte-identical** to today's emitted `docker-compose.yml` (locks SC-002). Use an inline string snapshot or `toMatchInlineSnapshot` so the fix can't drift `bind` mode silently.
- [ ] T002 [US1] Extend `scaffolder.test.ts` with `volume`-mode assertions per contract `scaffolder-volume-mode.md` Q2–Q5: both `services.orchestrator.volumes` and `services.worker.volumes` include `./claude.json:/home/node/.claude.json`; neither includes `claude-config:/home/node/.claude.json`; top-level `volumes` map does NOT contain a `claude-config` key.
- [ ] T003 [US1] Extend `scaffolder.test.ts` with idempotency tests per contract Q6–Q8 / FR-002, FR-003: first call to `scaffoldDockerCompose` in `volume` mode creates `<dir>/claude.json` with contents `"{}\n"`; second call against a pre-existing `claude.json` (with arbitrary non-`{}` contents) leaves bytes and `mtime` unchanged. Use a tmp directory per test.
- [ ] T004 [P] [US1] Add a test in `scaffolder.test.ts` that exercises the chown failure path (FR-004, FR-008): stub/spy `node:fs.chownSync` to throw `EPERM` (or `EACCES`); assert `scaffoldDockerCompose` returns successfully, the scaffolder logger receives one `warn` with the file path, and `claude.json` is still written. (Use vitest `vi.mock`/`vi.spyOn` on the logger module already used by scaffolder.)

## Phase 2: Core Fix — Scaffolder

- [ ] T005 [US1] In `packages/generacy/src/cli/commands/cluster/scaffolder.ts`, change the `claudeConfigVolume` ternary so the `volume` branch emits `./claude.json:/home/node/.claude.json` instead of `claude-config:/home/node/.claude.json` (FR-001). The `bind` branch stays `~/.claude.json:/home/node/.claude.json`.
- [ ] T006 [US1] In the same file, remove the `claude-config:` entry from the top-level `volumes:` map when `claudeConfigMode === 'volume'` (was scaffolder.ts:~258 dead reference; FR-005). Verify `bind` mode never declared it and still doesn't (FR-006 / US2 acceptance).
- [ ] T007 [US1] In `scaffolder.ts`, after writing `docker-compose.yml` and only when `claudeConfigMode === 'volume'`, create `<dir>/claude.json` with contents `"{}\n"` via `writeFileSync` — but **only if `existsSync` returns false** (FR-002, FR-003). Import `existsSync` from `node:fs`.
- [ ] T008 [US1] In `scaffolder.ts`, immediately after writing a fresh `claude.json`, call `chownSync(path, 1000, 1000)` inside a try/catch. On `EPERM`/`EACCES`, log via the existing scaffolder logger (`logger.warn`) with the file path and errno code; rethrow any other errno (FR-004, FR-008, contract Error Behavior table). Add a single one-line comment explaining the 1000:1000 = container `node` user.
- [ ] T009 [P] [US1] Re-run vitest for the cluster scaffolder tests (`pnpm --filter @generacy-ai/generacy test scaffolder`) and confirm T001 snapshot still matches and T002–T004 pass.

## Phase 3: Core Fix — Remote-Compose SSH Step

- [ ] T010 [US3] In `packages/generacy/src/cli/commands/deploy/remote-compose.ts`, after `scpDirectory(...)` (and `writeRemoteDockerConfig` if present) and **before** the `docker compose pull` `sshExec`, add a new `sshExec(target, ...)` running the exact command from `contracts/remote-compose-ownership.md`:
  ```sh
  test -f "${remotePath}/claude.json" || install -o 1000 -g 1000 -m 0600 /dev/null "${remotePath}/claude.json"; chown 1000:1000 "${remotePath}/claude.json" 2>/dev/null || true
  ```
  Interpolate `remotePath` with the same quoting style used by the surrounding `sshExec` calls (FR-007). No conditional on `claudeConfigMode` — `deploy` always passes `volume`.
- [ ] T011 [P] [US3] If `packages/generacy/src/cli/commands/deploy/__tests__/remote-compose.test.ts` (or similar) exists, add a unit test that mocks `sshExec` and asserts the ownership-fix command is invoked once, after `scpDirectory`, before the `docker compose pull` call, and contains both `install -o 1000 -g 1000 -m 0600` and `chown 1000:1000 ... 2>/dev/null || true`. If no such test file exists, skip — manual SC-005 covers it.

## Phase 4: Manual Verification (Success Criteria)

- [ ] T012 [US1] SC-001 manual repro per `quickstart.md`: scaffold a `volume`-mode cluster locally (script invoking `scaffoldDockerCompose` with `claudeConfigMode: 'volume'` or via `generacy deploy` to a localhost test target), then `docker compose up -d` against the scaffolded directory; confirm both `orchestrator` and `worker` reach `running` with no `is not directory` error in `docker compose logs`.
- [ ] T013 [US2] SC-002 verification: diff `docker-compose.yml` from a `bind`-mode scaffold before vs after the change for an identical `ScaffoldComposeInput`. T001 codifies this; record the diff (should be empty) in the PR description.
- [ ] T014 [P] [US1] SC-003 manual repro: inside the running `volume`-mode orchestrator, run `claude /login`, complete auth, then `docker compose down && docker compose up -d`; re-attach and confirm `claude` does not require re-auth (session token persisted through `claude.json`).
- [ ] T015 [P] [US1] SC-004 manual repro: after T014, re-run the scaffolder against the same directory; `sha256sum claude.json` before and after must match (FR-003 / contract I2).
- [ ] T016 [P] [US3] SC-005 manual repro: `generacy deploy ssh://<non-root-user>@<vm>` against a VM where the SSH user lacks `sudo`; confirm scaffolder + remote-compose finish without throwing; orchestrator reaches `running`; chown warning (or silent `|| true` on the VM) does not abort the run.

## Dependencies & Execution Order

**Phase 1 (Tests First)** must precede **Phase 2 (Scaffolder fix)** — locks `bind` byte-equality and defines `volume` postconditions before the implementation lands.

Within Phase 1, T001 → T002 → T003 are sequential because they all edit the same file (`scaffolder.test.ts`); T004 is also same-file but marked `[P]` only conceptually (logically independent test case). If the editor allows, batch them into a single edit pass.

**Phase 2 (T005–T009)** is sequential — T005/T006/T007/T008 all edit `scaffolder.ts` and must be applied in order (volume bind string → top-level volumes → file write → chown). T009 (test run) gates moving on to Phase 3.

**Phase 3 (T010–T011)** is independent of Phase 2's `scaffolder.ts` edits in terms of file, but logically depends on the volume-mode contract being settled (Phase 1 contracts read). Can be done in parallel with Phase 2 by a second contributor.

**Phase 4 (T012–T016)** depends on Phases 2 and 3 being complete. T014 and T015 are sequential (T015 requires T014's session). T012/T013/T016 are independent (`[P]`).

**Parallel opportunities**:
- T009 (test re-run) and any Phase 3 work can overlap.
- T014 and T015 cannot parallelize (T015 reads the file T014 wrote).
- T012 (local up), T013 (diff check), T016 (VM deploy) are all `[P]`.

## Suggested Next Step

Run `/speckit:implement` to begin executing tasks in order, or `/speckit:taskstoissues` to convert into child GitHub issues using the default `per-story` grouping.

---

*Generated by speckit*
