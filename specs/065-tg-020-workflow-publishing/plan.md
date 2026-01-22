# Implementation Plan: Workflow Publishing

**Feature**: Workflow Publishing - Local to cloud workflow sync with version management and diff comparison
**Branch**: `065-tg-020-workflow-publishing`
**Status**: Complete

## Summary

Implement the workflow publishing feature (TG-020) as part of the Generacy VS Code Extension. This feature enables users to:
1. Publish locally developed workflows to the cloud
2. Compare local and cloud versions with visual diff
3. View version history and rollback to previous versions
4. Monitor sync status in the workflow explorer
5. Create changelogs when publishing

This is Phase 10 of the epic and requires prior completion of Authentication (TG-015) and API Client (TG-014).

## Technical Context

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| Language | TypeScript | Consistent with extension stack |
| Framework | VS Code Extension API | Native extension development |
| API Client | Existing ApiClient singleton | Reuses authentication, retry, validation |
| Diff Library | Built-in VS Code diffEditor API | Native diff UI, no external deps |
| Validation | Zod (^3.23.0) | Consistent with existing API types |
| YAML Handling | yaml (^2.4.0) | Already used throughout extension |
| Testing | Vitest | Consistent with existing test setup |

## Project Structure

```
packages/generacy-extension/src/
├── api/
│   └── endpoints/
│       └── workflows.ts               # NEW: Workflow publishing API endpoints
│
├── views/
│   └── cloud/
│       └── publish/
│           ├── index.ts               # NEW: Module exports
│           ├── sync.ts                # NEW: Publish workflow command handler
│           ├── compare.ts             # NEW: Diff comparison view
│           ├── version.ts             # NEW: Version history panel
│           └── __tests__/
│               ├── sync.test.ts       # NEW: Sync tests
│               ├── compare.test.ts    # NEW: Compare tests
│               └── version.test.ts    # NEW: Version tests
│
├── commands/
│   └── cloud.ts                       # MODIFY: Register publishWorkflow command
│
└── extension.ts                       # MODIFY: Register new commands
```

## Dependencies

### Existing Dependencies (Already Available)
- `yaml` (^2.4.0) - YAML parsing for workflow content
- `zod` (^3.23.0) - Schema validation for API responses
- `@types/vscode` (^1.85.0) - VS Code API types

### No New Dependencies Required
All required functionality is provided by:
- VS Code native APIs (diffEditor, QuickPick, TreeView)
- Existing API client infrastructure
- Existing utilities (logger, config, errors)

## Implementation Tasks

This implementation directly addresses the 6 tasks specified in the issue:

### Task 1: Implement `generacy.publishWorkflow` Command
**File**: `src/views/cloud/publish/sync.ts`

Command flow:
1. **Get current workflow**: Read active YAML file from `.generacy/` directory
2. **Validate workflow**: Parse and validate YAML structure
3. **Check authentication**: Verify user has valid cloud auth tokens
4. **Fetch cloud version**: GET `/workflows/:name` to compare
5. **Show diff if exists**: Call `showWorkflowDiff()` if cloud version exists
6. **Prompt for changelog**: Show input box for changelog message
7. **Confirm publish**: Show QuickPick with summary and changelog
8. **Publish**: POST `/workflows/publish` with workflow content
9. **Update UI**: Refresh explorer decorations to show sync status

**API Integration**:
```typescript
POST /workflows/publish
Request: {
  name: string;
  content: string;  // Raw YAML
  changelog?: string;
  tag?: string;
}
Response: {
  id: string;
  version: number;
  publishedAt: string;
}
```

### Task 2: Create Diff Comparison View (Local vs Cloud)
**File**: `src/views/cloud/publish/compare.ts`

Features:
- Use `vscode.diff` command with custom URIs
- Left side: Cloud version (read-only, from API)
- Right side: Local version (current file)
- Custom URI scheme: `generacy-cloud://workflow/:name/:version`
- TextDocumentContentProvider for cloud workflow fetching

Implementation:
```typescript
async function showWorkflowDiff(
  workflowName: string,
  localContent: string,
  cloudContent: string
): Promise<void> {
  // Create virtual URIs
  const cloudUri = vscode.Uri.parse(`generacy-cloud://workflow/${workflowName}/cloud`);
  const localUri = vscode.Uri.file(localPath);

  // Open diff editor
  await vscode.commands.executeCommand(
    'vscode.diff',
    cloudUri,
    localUri,
    `${workflowName}: Cloud ↔ Local`
  );
}
```

### Task 3: Build Version History Panel
**File**: `src/views/cloud/publish/version.ts`

QuickPick-based version browser:
- Shows list of all versions with metadata
- Displays: version number, tag, timestamp, publisher, changelog
- Actions: View, Compare to Local, Rollback
- Sorted by version descending (newest first)

API Integration:
```typescript
GET /workflows/:name/versions
Response: {
  versions: Array<{
    version: number;
    tag?: string;
    publishedAt: string;
    publishedBy: string;
    changelog?: string;
  }>;
}

GET /workflows/:name/versions/:version
Response: {
  content: string; // YAML content
}
```

### Task 4: Add Rollback to Previous Version Functionality
**File**: `src/views/cloud/publish/version.ts`

Rollback flow:
1. User selects "Rollback" from version history panel
2. Show confirmation dialog with version details
3. Fetch version content: GET `/workflows/:name/versions/:version`
4. Publish as new version with auto-generated changelog: "Rolled back to version X"
5. Update local file with rolled-back content (optional, prompt user)

**Important**: Rollback creates a NEW version (not destructive). History is preserved.

### Task 5: Implement Sync Status Indicators in Explorer
**Files**:
- `src/views/local/explorer/decorations.ts` (MODIFY)
- `src/views/cloud/publish/sync.ts` (NEW)

Status indicators:
- ✓ (green): Local matches cloud (synced)
- ↑ (yellow): Local ahead of cloud (unpublished changes)
- ↓ (blue): Cloud ahead of local (fetch available)
- ⚠ (red): Conflict detected (manual resolution needed)
- ⊘ (gray): Not published to cloud yet

Implementation:
1. Add `FileDecorationProvider` for workflow files
2. Check sync status on file open/save/publish
3. Cache status to avoid excessive API calls (5min TTL)
4. Update on publish/rollback events

### Task 6: Create Publish Confirmation with Changelog Prompt
**File**: `src/views/cloud/publish/sync.ts`

Two-step confirmation UI:
1. **Input Box**: Changelog message (optional but recommended)
   - Placeholder: "Describe what changed in this version"
   - Support multiline input
2. **QuickPick**: Publish confirmation
   - Show summary: workflow name, changes detected, changelog preview
   - Options: "Publish Now", "Review Diff", "Cancel"
   - If "Review Diff" selected, show diff and re-prompt

## API Endpoint Implementation

### New File: `src/api/endpoints/workflows.ts`

```typescript
import { z } from 'zod';
import { getApiClient } from '../client';
import {
  PublishedWorkflowSchema,
  WorkflowVersionSchema,
  PublishWorkflowRequestSchema,
  type PublishedWorkflow,
  type WorkflowVersion,
  type PublishWorkflowRequest,
} from '../types';

// Publish workflow
export async function publishWorkflow(
  request: PublishWorkflowRequest
): Promise<{ id: string; version: number; publishedAt: string }> {
  const client = getApiClient();
  const response = await client.postValidated(
    '/workflows/publish',
    z.object({
      id: z.string(),
      version: z.number().int().positive(),
      publishedAt: z.string().datetime(),
    }),
    request
  );
  return response.data;
}

// Get published workflow details
export async function getPublishedWorkflow(name: string): Promise<PublishedWorkflow> {
  const client = getApiClient();
  const response = await client.getValidated(`/workflows/${encodeURIComponent(name)}`, PublishedWorkflowSchema);
  return response.data;
}

// Get version history
export async function getWorkflowVersions(name: string): Promise<WorkflowVersion[]> {
  const client = getApiClient();
  const response = await client.getValidated(
    `/workflows/${encodeURIComponent(name)}/versions`,
    z.object({ versions: z.array(WorkflowVersionSchema) })
  );
  return response.data.versions;
}

// Get specific version content
export async function getWorkflowVersion(name: string, version: number): Promise<string> {
  const client = getApiClient();
  const response = await client.getValidated(
    `/workflows/${encodeURIComponent(name)}/versions/${version}`,
    z.object({ content: z.string() })
  );
  return response.data.content;
}
```

## Key Technical Decisions

1. **Diff View Implementation**: Using VS Code's native `vscode.diff` command instead of custom webview. This provides:
   - Native diff UI matching user's theme
   - Built-in line-by-line comparison
   - No additional dependencies
   - Consistent UX with other VS Code diff views

2. **Version History UI**: QuickPick instead of TreeView. Rationale:
   - Versions are workflow-specific (not global navigation)
   - QuickPick provides better detail view (description field)
   - Faster to implement without tree hierarchy complexity
   - More appropriate for action-oriented UI

3. **Sync Status Caching**: 5-minute TTL on sync status to reduce API calls:
   - File watchers trigger cache invalidation on save
   - Publish/rollback actions invalidate cache
   - Manual refresh command available

4. **Rollback as New Version**: Non-destructive rollback creates new version:
   - Preserves full history for audit trail
   - Allows "undo rollback" by rolling forward again
   - Follows Git-style version management

5. **Changelog Prompt**: Optional but encouraged via UI nudges:
   - Warning icon if changelog is empty
   - QuickPick shows "No changelog" prominently
   - Best practice guidance in confirmation message

## Testing Strategy

| Test Type | Coverage | Approach |
|-----------|----------|----------|
| Unit Tests | API functions, diff logic, version parsing | Vitest with mocked ApiClient |
| Integration Tests | Command execution, UI flows | @vscode/test-electron |
| Manual Testing | Diff UI, QuickPick interactions | Dev extension host |

### Test Scenarios

**Publishing**:
- ✓ Publish new workflow (no cloud version)
- ✓ Publish update to existing workflow
- ✓ Publish with changelog
- ✓ Publish without changelog (show warning)
- ✗ Publish without authentication (should fail gracefully)
- ✗ Publish invalid YAML (should fail validation)

**Diff Comparison**:
- ✓ Show diff when cloud version exists
- ✓ Handle identical local/cloud versions
- ✓ Display formatting differences (whitespace)
- ✓ Close diff editor cleanly

**Version History**:
- ✓ List all versions sorted newest first
- ✓ Show version details in QuickPick
- ✓ Handle empty version history (not published)
- ✓ Navigate to specific version content

**Rollback**:
- ✓ Rollback creates new version
- ✓ Rolled-back content matches target version
- ✓ Changelog auto-generated for rollback
- ✓ User can update local file after rollback

**Sync Status**:
- ✓ Show synced status (green checkmark)
- ✓ Show ahead status (yellow arrow up)
- ✓ Show behind status (blue arrow down)
- ✓ Show not published status (gray circle)
- ✓ Cache invalidation on publish

## Error Handling

### Authentication Errors
- **401 Unauthorized**: Prompt user to re-authenticate
- **403 Forbidden**: Show message about organization access required
- **Action**: Open authentication flow or settings

### Network Errors
- **Timeout**: Show retry dialog with exponential backoff
- **Connection Failed**: Show offline indicator, queue publish for retry
- **Action**: Store publish request locally, retry when connection restored

### Validation Errors
- **Invalid YAML**: Show error message with line number
- **Missing Required Fields**: Highlight specific issues in workflow
- **Action**: Open workflow file at error location

### Conflict Errors
- **409 Conflict**: Cloud version changed during edit
- **Action**: Show three-way merge dialog (local, cloud, base)

## Configuration

### VS Code Settings
```json
{
  "generacy.publish.autoSync": false,
  "generacy.publish.confirmBeforePublish": true,
  "generacy.publish.requireChangelog": false,
  "generacy.publish.syncStatusCacheTTL": 300000
}
```

### Extension Activation Events
Add to `package.json`:
```json
"activationEvents": [
  "onCommand:generacy.publishWorkflow",
  "onCommand:generacy.viewVersionHistory",
  "onCommand:generacy.compareWithCloud"
]
```

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Publish command execution | < 2s (excluding API) | Performance profiling |
| Diff view open time | < 500ms | User experience testing |
| Version history load | < 1s | API response time |
| Sync status cache hit rate | > 80% | Telemetry data |

## Integration Points

### Existing Components
1. **API Client** (`src/api/client.ts`): Used for all HTTP requests
2. **Authentication** (`src/api/auth.ts`): Provides tokens for API calls
3. **Workflow Explorer** (`src/views/local/explorer/`): Shows sync status decorations
4. **Logger** (`src/utils/logger.ts`): Logs publish operations
5. **Error Handler** (`src/utils/errors.ts`): Standardized error messages

### New Commands
- `generacy.publishWorkflow`: Publish current workflow
- `generacy.viewVersionHistory`: Show version history picker
- `generacy.compareWithCloud`: Open diff view for current workflow
- `generacy.rollbackWorkflow`: Rollback to specific version
- `generacy.refreshSyncStatus`: Manually refresh sync indicators

## Security Considerations

1. **Authentication**: All API requests require valid OAuth tokens
2. **Authorization**: User must be member of organization to publish
3. **Content Sanitization**: YAML content validated before publish
4. **Rate Limiting**: Client respects API rate limits (handled by ApiClient)
5. **Token Refresh**: Automatic token refresh on 401 errors

## Phase Dependencies

This task group (TG-020) depends on:
- ✓ TG-014: API Client Foundation (provides `ApiClient`)
- ✓ TG-015: GitHub OAuth Authentication (provides auth tokens)
- ✓ TG-004: Workflow Explorer (for sync status decorations)

This task group enables:
- TG-021: Error Handling & UX Polish (publishes to cloud, needs error scenarios)
- TG-022: Documentation & Marketplace Assets (showcase publishing feature)

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| API schema changes | High | Use Zod validation, version API endpoints |
| Large workflow files | Medium | Stream content, add size limits (5MB) |
| Concurrent edits | Medium | Implement conflict detection and resolution UI |
| Network interruptions | Low | Cache requests, implement retry with exponential backoff |
| Invalid YAML | Low | Pre-publish validation with user-friendly error messages |

---

*Generated by speckit*
