# Feature Specification: Architecture Overview for Adopters

**Branch**: `257-6-3-architecture-overview` | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Create a public-facing architecture overview document that enables external developers (adopters) to understand how Generacy works without reading internal documentation. The document lives in the public `generacy` repo and covers the system from an adopter's perspective: what happens when they label a GitHub issue, how the orchestrator picks it up, how workers execute workflows, how clarification and review cycles work, and how to customize workflows. The focus is on practical understanding — what adopters need to know to use and configure the system — not internal implementation details.

### Tasks
- Simplified architecture diagram (what adopters need to know, not internal details)
- How the orchestrator, workers, and GitHub interaction work
- Label protocol explanation
- How clarification/review cycles work
- How to customize workflows

### Acceptance Criteria
Adopter can understand how the system works without reading internal docs.

### Dependencies
None (can start at any time, but best written after implementation)

### Plan Reference
[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 6.3

---
### Execution
**Phase:** 6 — Documentation
**Blocked by:**
- [ ] All implementation phases substantially complete

## User Stories

### US1: New adopter understands the system

**As a** developer evaluating Generacy for my team,
**I want** a clear architecture overview that explains how the system works end-to-end,
**So that** I can assess whether it fits my needs and understand what to expect when I adopt it.

**Acceptance Criteria**:
- [ ] Can identify all major components (orchestrator, workers, GitHub) and their roles from a single diagram
- [ ] Understands the flow from "label an issue" to "PR ready for review" without additional reading
- [ ] No references to internal repos, internal docs, or implementation details that adopters cannot access

### US2: Adopter understands the label protocol

**As a** developer using Generacy on my project,
**I want** to understand what each label means and how labels drive the workflow,
**So that** I can follow issue progress and know when my input is needed.

**Acceptance Criteria**:
- [ ] All label categories are explained with their purpose (trigger, phase, waiting-for, completed)
- [ ] The lifecycle of a typical feature issue is shown step-by-step with label transitions
- [ ] Clear guidance on which labels the developer adds vs. which the system manages automatically

### US3: Adopter knows how to respond to clarification requests

**As a** developer whose issue is being processed by Generacy,
**I want** to understand how the clarification cycle works,
**So that** I can answer questions promptly and unblock the workflow.

**Acceptance Criteria**:
- [ ] The clarification comment format is explained with an example
- [ ] Steps to answer questions and resume the workflow are clearly documented
- [ ] The review cycle for specs and PRs is explained separately from clarification

### US4: Adopter can customize workflows

**As a** a team lead setting up Generacy for my organization,
**I want** to understand how to customize workflows,
**So that** I can adapt Generacy to my team's development process.

**Acceptance Criteria**:
- [ ] YAML workflow definition format is introduced with a minimal example
- [ ] Available built-in actions are listed (shell, agent.invoke, verification, github.pr-create, etc.)
- [ ] The difference between local and cloud workflow execution is explained
- [ ] Workflow publishing process is described at a high level

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Simplified architecture diagram showing orchestrator, worker, GitHub, and adopter touchpoints | P1 | ASCII art or Mermaid; must render in GitHub markdown |
| FR-002 | End-to-end flow narrative: issue labeled → spec → clarify → plan → implement → validate → PR | P1 | Walk through the `speckit-feature` workflow as the canonical example |
| FR-003 | Label protocol reference table covering trigger, phase, waiting-for, and completed labels | P1 | Separate "you manage" vs "system manages" labels |
| FR-004 | Clarification cycle explanation with example comment format and response instructions | P1 | Include the Q&A format and the `completed:clarification` label step |
| FR-005 | Review cycle explanation for specs, plans, and PR feedback | P1 | Cover `waiting-for:spec-review`, `waiting-for:address-pr-feedback`, etc. |
| FR-006 | Workflow customization overview: YAML format, built-in actions, variable interpolation | P2 | Keep minimal; link to detailed workflow authoring guide when available |
| FR-007 | Orchestrator configuration reference: env vars, watched repos YAML | P2 | Focus on what adopters configure, not internal architecture |
| FR-008 | Error handling and recovery: what happens when things go wrong, how to retry | P2 | Cover `agent:error` label, `needs:intervention`, and retry via re-labeling |
| FR-009 | Bugfix workflow variant: shortened flow without clarification phase | P2 | Brief comparison to feature workflow |
| FR-010 | Epic processing overview: how epics generate child issues | P3 | Brief section; epics are an advanced use case |
| FR-011 | Glossary of key terms (orchestrator, worker, phase, label protocol, dev container) | P3 | Quick-reference for adopters unfamiliar with terminology |
| FR-012 | Document lives in `docs/architecture-overview.md` in the public `generacy` repo | P1 | Must be accessible without access to `tetrad-development` |

## Document Structure

The architecture overview document should follow this structure:

1. **Introduction** — What Generacy is in one paragraph; link to quickstart
2. **How It Works (diagram)** — Simplified component diagram showing: GitHub Issues/PRs ↔ Orchestrator (Monitor + Queue) ↔ Worker (Claude CLI) ↔ Your Codebase
3. **The Workflow Lifecycle** — Step-by-step walkthrough of a feature issue from label to merged PR
4. **Label Protocol** — Table of all labels with "who adds it" and "what it means" columns
5. **Clarification Cycles** — How the system asks questions, how you answer, how it resumes
6. **Review Cycles** — Spec review, plan review, PR feedback handling
7. **Error Handling** — What happens on failure, how to retry
8. **Customizing Workflows** — YAML format overview, built-in actions, local vs cloud execution
9. **Configuration Reference** — Environment variables, repo config, webhook setup
10. **Glossary** — Key terms

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Adopter comprehension | An adopter can describe the end-to-end flow after reading the doc | Walkthrough test with 2-3 external developers |
| SC-002 | Self-service clarification response | Adopter can correctly respond to a clarification comment without external help | Test: give adopter a sample clarification comment, verify they know what to do |
| SC-003 | No internal references | Zero references to `tetrad-development`, internal docs, or private repos | Automated grep of the published document |
| SC-004 | Document completeness | All 5 task areas from the issue are covered | Checklist review against issue tasks |
| SC-005 | Readability | Document is under 1500 lines; diagrams use GitHub-renderable format | Line count + rendering check |

## Assumptions

- The label protocol as defined in `tetrad-development/docs/label-protocol.md` is stable and will not change significantly before this doc is written
- The orchestrator, worker, and workflow engine implementations are substantially complete and match the architecture described in `generacy-architecture-overview-v3.md`
- The target audience has familiarity with GitHub (issues, labels, PRs) but no prior knowledge of Generacy
- ASCII art diagrams are acceptable; Mermaid diagrams are preferred if the doc will be rendered on a platform that supports them
- Workflow customization via YAML is the supported mechanism; programmatic workflow definition is not documented for adopters

## Out of Scope

- Internal architecture details (Redis internals, deduplication logic, heartbeat protocol)
- Humancy platform documentation (deferred to post-MVP)
- Agency MCP server documentation (covered by separate Agency docs)
- Detailed workflow authoring guide (separate doc; this overview links to it)
- Pricing, billing, or subscription tier details
- Cloud infrastructure or deployment architecture
- API reference documentation
- VS Code extension usage guide (covered by separate extension docs)

---

*Generated by speckit*
