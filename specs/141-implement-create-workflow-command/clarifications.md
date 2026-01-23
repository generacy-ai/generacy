# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-23 18:37

### Q1: File Naming
**Context**: The workflow needs to be saved with a filename. This affects UX and discoverability.
**Question**: How should the workflow filename be determined?
**Options**:
- A: Prompt user for a name (e.g., 'my-workflow.yaml')
- B: Auto-generate from template name + timestamp (e.g., 'basic-20260123.yaml')
- C: Use template name directly (e.g., 'basic.yaml'), with numeric suffix if exists

**Answer**: A: Prompt user for a name. The spec emphasizes workflows as "version controlled" and "debuggable like code." The Workflow Explorer mockups show meaningful names like `develop-issue.yaml`, `review-pr.yaml`, `hotfix.yaml`. User-chosen names make workflows discoverable and convey intent at a glance.

### Q2: No Workspace Handling
**Context**: The command may be invoked when no workspace folder is open, preventing file creation in .generacy/workflows/.
**Question**: What should happen when no workspace folder is open?
**Options**:
- A: Show error: 'Open a workspace folder to create workflows'
- B: Prompt to open a folder, then continue
- C: Allow creating in any user-selected location

**Answer**: A: Show error message. Workflows are inherently project-specific, stored in `.generacy/workflows/`. Without a workspace there's no project context and the workflow can't be part of version control. A clear error message is the appropriate response.

### Q3: Directory Creation
**Context**: The .generacy/workflows/ directory may not exist when creating the first workflow.
**Question**: Should the command auto-create the .generacy/workflows/ directory if it doesn't exist?
**Options**:
- A: Yes, create it automatically without prompting
- B: Yes, but confirm with user first
- C: No, show error asking user to create it manually

**Answer**: A: Auto-create without prompting. Standard UX for first-time setup. The directory structure is well-defined (`.generacy/workflows/`). Creating it automatically reduces friction for new users and matches common IDE patterns.

### Q4: Wizard Scope
**Context**: The issue mentions 'optional wizard for workflow configuration' but doesn't define scope.
**Question**: Should the initial implementation include a configuration wizard, or just template selection?
**Options**:
- A: Just template selection (QuickPick) - wizard deferred to future
- B: Simple wizard: name input + template selection
- C: Full wizard: name, description, phases, triggers configuration

**Answer**: B: Simple wizard (name + template selection). Since we need both a name (Q1=A) and template selection, a simple wizard combining these two inputs is appropriate. This provides minimal friction while deferring advanced configuration (phases, triggers, etc.) to the YAML editor, matching the "progressive complexity" design philosophy.

