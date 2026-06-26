# Epic: Cockpit

Plan: docs/epic-cockpit-plan.md in tetrad-development (P3 / G3.1)

This epic tracks the v2 epic cockpit pipeline rollout. The Children by phase
section below is parsed by `generacy cockpit manifest init/sync` to produce
`.generacy/epics/cockpit.yaml`.

## Children by phase

### P0 — Foundation → v1

The foundation phase ships the shared `@generacy-ai/cockpit` package — schema,
IO, and the gh wrapper that every other verb consumes.

- [x] generacy-ai/generacy#786 — `@generacy-ai/cockpit` foundation
- [x] generacy-ai/generacy#787 — gh wrapper

### P3 — Manifest → v2

Adds the `manifest init/sync` verb that creates and reconciles the per-epic
YAML. After this phase, `cockpit queue <phase>` can read the manifest directly.

- [ ] generacy-ai/generacy#790 — manifest init/sync verb
- [ ] generacy-ai/generacy#791 — `cockpit queue <phase>`

### P4 — Hardening → v3

Final polish before flipping the autonomy gate.

- generacy-ai/generacy#792
