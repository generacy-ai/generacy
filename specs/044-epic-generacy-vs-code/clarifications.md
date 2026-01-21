# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-21 18:24

### Q1: Workflow Schema Definition
**Context**: The extension needs to validate and provide intellisense for .generacy/*.yaml files. Implementation cannot begin without knowing the schema structure.
**Question**: What is the schema for workflow YAML files? Is there an existing schema definition, or should we define one as part of this epic?
**Options**:
- A: Use existing schema from @generacy-ai/contracts
- B: Define new schema as part of this epic (provide initial structure)
- C: Schema definition is a separate prerequisite issue

**Answer**: *Pending*

### Q2: Local Execution Runtime
**Context**: Local workflow execution needs a runtime environment. The choice affects dependencies, setup complexity, and user requirements.
**Question**: What runtime executes workflows locally? How should the extension invoke workflow steps?
**Options**:
- A: Node.js runtime bundled with extension
- B: Docker containers (user must have Docker installed)
- C: Shell commands executed directly
- D: Hybrid approach (describe which)

**Answer**: *Pending*

### Q3: generacy.ai API Status
**Context**: Cloud features require API integration. Implementation approach differs significantly based on API availability.
**Question**: Is the generacy.ai platform API already implemented, or is it being developed in parallel? What API client/SDK should the extension use?
**Options**:
- A: API exists and is documented - provide endpoint reference
- B: API contracts exist but implementation is in progress
- C: API design is part of this epic

**Answer**: *Pending*

### Q4: Offline Local Mode
**Context**: Users may want to develop workflows without internet access. This affects authentication and feature availability.
**Question**: Should Local Mode work completely offline, or does it require a generacy.ai connection even for local features?
**Options**:
- A: Fully offline - no connection required for local features
- B: Requires initial authentication, then works offline
- C: Always requires connection (even for local mode)

**Answer**: *Pending*

### Q5: MVP Scope Priority
**Context**: This is a large epic with 8 major features across two modes. Defining MVP scope helps prioritize child issues.
**Question**: What is the minimum viable release scope? Which features must be in v1.0 vs. can be added in later versions?
**Options**:
- A: Local Mode only for MVP (features 1-4)
- B: Core features from both modes (Explorer, Editor, Runner, Dashboard, Queue)
- C: All features required for MVP

**Answer**: *Pending*

