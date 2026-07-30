---
'@generacy-ai/cockpit': minor
'@generacy-ai/generacy': patch
---

Cluster-side integration harness for the Cockpit Remote Gates epic (#1024).

Composes the four P1 siblings end-to-end against a fake relay peer — no cloud,
no live GitHub, no smee: a light in-process orchestrator (real gate/answer
routes + answers-file writer + retain-and-replay retainer), a real
`ClusterRelayClient` dialed at a `ws` fake peer, and the REAL `generacy cockpit
doorbell` spawned as a child process. The eight cross-component scenarios of
`specs/1024-part-cockpit-remote-gates/contracts/scenario-catalog.md` (S1a, S1b,
S2, S3, S4, S5, F1, F2, F3) run with real assertions.

Public API (`@generacy-ai/cockpit`, minor): adds wire-envelope fixture builders
so cluster and cloud (P2) single-source the transport shapes — `gateOpenFixture`,
`gateAckFixture`, `answerLineFixture`, `DEFAULT_WIRE_SCOPE`, `DEFAULT_WIRE_EPIC_REF`.
The `packages/cockpit/README.md` §"Gates protocol" table is updated to match.

Doorbell (`@generacy-ai/generacy`, patch): the `cockpit doorbell` command now
honours `COCKPIT_ANSWERS_FILE` for its tail target, plus an env-gated hermetic
harness mode (`COCKPIT_DOORBELL_HARNESS=1`) that tails the answers file with a
local in-process bus and no GitHub — the seam that lets the harness exercise
FR-005/007/013/015 against the real binary offline (FR-012 / env-seams S-5).
