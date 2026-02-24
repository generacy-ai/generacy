# Label State Machine Diagram

## Before Fix (Current Behavior — BUG)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Process Event                            │
└─────────────────────────────────────────────────────────────────┘
                              ▼
                    [agent:in-progress] ✅
                              ▼
                    ┌─────────────────┐
                    │  Phase: specify │
                    └─────────────────┘
                              ▼
                    ┌─────────────────┐
                    │  Phase: clarify │
                    └─────────────────┘
                              ▼
                    ⚠️ Clarification Gate Hit
                              ▼
                    [agent:paused] +
                    [waiting-for:clarification]
                              ▼
                    [Workflow Pauses — waiting for human]
                              ▼
                    [Clarification Provided]
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Resume Event                             │
└─────────────────────────────────────────────────────────────────┘
                              ▼
                    Remove: [agent:paused],
                            [waiting-for:clarification]
                              ▼
                    ❌ NO AGENT STATUS LABEL ❌  ← BUG!
                              ▼
                    ┌─────────────────┐
                    │  Phase: plan    │  ← Issue shows as "not paused, not active"
                    └─────────────────┘
                              ▼
                    ┌─────────────────┐
                    │ Phase: implement│  ← Still no agent status!
                    └─────────────────┘
                              ▼
                    [Workflow Complete]
                              ▼
                    (No label to remove)
```

**Problem**: Issue appears to have no active workflow between resume and completion.

---

## After Fix (Desired Behavior)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Process Event                            │
└─────────────────────────────────────────────────────────────────┘
                              ▼
                    [agent:in-progress] ✅
                              ▼
                    ┌─────────────────┐
                    │  Phase: specify │
                    └─────────────────┘
                              ▼
                    ┌─────────────────┐
                    │  Phase: clarify │
                    └─────────────────┘
                              ▼
                    ⚠️ Clarification Gate Hit
                              ▼
                    Remove: [agent:in-progress]
                    Add: [agent:paused] +
                         [waiting-for:clarification]
                              ▼
                    [Workflow Pauses — waiting for human]
                              ▼
                    [Clarification Provided]
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Resume Event                             │
└─────────────────────────────────────────────────────────────────┘
                              ▼
                    Remove: [agent:paused],
                            [waiting-for:clarification]
                              ▼
                    Add: [agent:in-progress] ✅  ← FIX!
                              ▼
                    ┌─────────────────┐
                    │  Phase: plan    │  ← Issue correctly shows as "active"
                    └─────────────────┘
                              ▼
                    ┌─────────────────┐
                    │ Phase: implement│  ← Still active
                    └─────────────────┘
                              ▼
                    [Workflow Complete]
                              ▼
                    Remove: [agent:in-progress]
```

**Solution**: Resume event adds `agent:in-progress`, matching process event behavior.

---

## Complete State Machine (All Paths)

```
                    ┌─────────────────────────────┐
                    │  Workflow Trigger Added     │
                    │  (process:* label)          │
                    └─────────────────────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                │                 │                 │
            [Process]         [Resume]        [Resume (no gate)]
                │                 │                 │
                ▼                 ▼                 ▼
    ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐
    │ monitor service │  │   worker     │  │   worker     │
    │ adds:           │  │ removes:     │  │ removes:     │
    │ - in-progress ✅│  │ - paused     │  │ - paused     │
    │ - workflow:*    │  │ - waiting-*  │  │ - waiting-*  │
    └─────────────────┘  │ adds:        │  │ adds:        │
                         │ - in-progress│  │ - in-progress│
                         └──────────────┘  └──────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │  [agent:in-progress]        │
                    │  Phase Loop Active          │
                    └─────────────────────────────┘
                                  │
                ┌─────────────────┼─────────────────┬──────────────┐
                │                 │                 │              │
          [Phase Start]    [Phase Complete]   [Gate Hit]    [Error]
                │                 │                 │              │
                ▼                 ▼                 ▼              ▼
       ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────┐
       │ add:         │  │ remove:      │  │ remove:      │  │ remove:│
       │ - phase:*    │  │ - phase:*    │  │ - phase:*    │  │ - phase│
       │ remove:      │  │ add:         │  │ - completed:*│  │ - in-pr│
       │ - phase:prev │  │ - completed:*│  │ add:         │  │ add:   │
       └──────────────┘  └──────────────┘  │ - waiting-*  │  │ - error│
                                            │ - paused ⚠️  │  └────────┘
                                            └──────────────┘
                                                    │
                                                    ▼
                                            [Workflow Pauses]
                                            [Human Action Needed]
                                                    │
                                                    ▼
                                            [Human Provides Input]
                                                    │
                                                    └──→ [Resume Event]
                                                          (loop back to top)


                    ┌─────────────────────────────┐
                    │  All Phases Complete        │
                    └─────────────────────────────┘
                                  ▼
                    ┌─────────────────────────────┐
                    │ onWorkflowComplete()        │
                    │ removes: [agent:in-progress]│
                    └─────────────────────────────┘
```

---

## Label State Comparison

### Process Event Flow (Working Correctly)

| Step | Labels | Agent Status Visible? |
|------|--------|----------------------|
| Trigger added | `process:speckit-feature` | ❌ No |
| Monitor service processes | `agent:in-progress`, `workflow:speckit-feature` | ✅ **Yes** |
| Phase: specify | `agent:in-progress`, `phase:specify` | ✅ Yes |
| Phase: plan | `agent:in-progress`, `completed:specify`, `phase:plan` | ✅ Yes |
| Complete | `completed:specify`, `completed:plan` | ❌ No (expected) |

### Resume Event Flow (Before Fix — BROKEN)

| Step | Labels | Agent Status Visible? |
|------|--------|----------------------|
| Gate hit | `waiting-for:clarification`, `agent:paused` | ⚠️ Paused |
| Clarification provided | `resume:speckit-feature` | ⚠️ Paused (stale) |
| Worker removes stale | (none) | ❌ **No — BUG!** |
| Phase: plan | `phase:plan` | ❌ **No — BUG!** |
| Phase: implement | `completed:plan`, `phase:implement` | ❌ **No — BUG!** |
| Complete | `completed:plan`, `completed:implement` | ❌ No (expected) |

### Resume Event Flow (After Fix — WORKING)

| Step | Labels | Agent Status Visible? |
|------|--------|----------------------|
| Gate hit | `waiting-for:clarification`, `agent:paused` | ⚠️ Paused |
| Clarification provided | `resume:speckit-feature` | ⚠️ Paused (stale) |
| Worker removes stale | (none) | (transitional) |
| Worker adds status | `agent:in-progress` | ✅ **Yes — FIXED!** |
| Phase: plan | `agent:in-progress`, `phase:plan` | ✅ **Yes** |
| Phase: implement | `agent:in-progress`, `completed:plan`, `phase:implement` | ✅ **Yes** |
| Complete | `completed:plan`, `completed:implement` | ❌ No (expected) |

---

## Edge Cases

### Edge Case 1: Resume Without Gate (Manual Label Cleanup)

**Scenario**: User manually removes `agent:paused` before providing input.

```
[Gate Hit]
  → Labels: [waiting-for:clarification, agent:paused]

[User Manually Removes agent:paused]
  → Labels: [waiting-for:clarification]

[User Provides Clarification]
  → Resume Event

[Worker: onResumeStart()]
  → Removes: [waiting-for:clarification]
  → Adds: [agent:in-progress]  ← Still works!

[Phase Loop Continues]
  → Labels: [agent:in-progress, phase:plan]  ✅
```

**Outcome**: Fix handles this correctly because we add `agent:in-progress` unconditionally.

### Edge Case 2: Retry Failure Between Operations

**Scenario**: Network failure between `removeLabels()` and `addLabels()`.

```
[Resume Event]
  ▼
[Worker: onResumeStart() — Attempt 1]
  → removeLabels([waiting-for:clarification, agent:paused])  ✅ Success
  → addLabels([agent:in-progress])  ❌ Network error

[Retry with backoff — Attempt 2 after 1s]
  → removeLabels([waiting-for:clarification, agent:paused])  ✅ No-op (idempotent)
  → addLabels([agent:in-progress])  ✅ Success

[Phase Loop Continues]
  → Labels: [agent:in-progress, phase:plan]  ✅
```

**Outcome**: Retry logic ensures correct final state. See `research.md` for full analysis.

### Edge Case 3: Multiple Gates in Sequence

**Scenario**: Workflow hits clarification gate, then later hits tasks-review gate.

```
[Phase: clarify]
  → Gate hit
  → Labels: [waiting-for:clarification, agent:paused]

[Resume 1: Clarification provided]
  → onResumeStart()
  → Removes: [waiting-for:clarification, agent:paused]
  → Adds: [agent:in-progress]  ✅
  → Labels: [agent:in-progress]

[Phase: plan → Phase: tasks]
  → Labels: [agent:in-progress, phase:tasks]

[Phase: tasks-review]
  → Gate hit again
  → Removes: [agent:in-progress]
  → Adds: [waiting-for:tasks-review, agent:paused]
  → Labels: [waiting-for:tasks-review, agent:paused]

[Resume 2: Tasks approved]
  → onResumeStart()
  → Removes: [waiting-for:tasks-review, agent:paused]
  → Adds: [agent:in-progress]  ✅
  → Labels: [agent:in-progress]

[Phase: implement continues]
  → Labels: [agent:in-progress, phase:implement]  ✅
```

**Outcome**: Fix works correctly for multiple gate cycles.

---

## Implementation Impact

### Before Fix
- ❌ Resume events: No agent status label
- ❌ Inconsistent with process events
- ❌ Users can't distinguish paused vs. active after resume

### After Fix
- ✅ Resume events: `agent:in-progress` label present
- ✅ Consistent with process events
- ✅ Users can reliably track workflow state

**Code changes**: +4 lines in `onResumeStart()`, +2 test assertions
**Risk**: Low (follows existing patterns, covered by retry logic)

---

*Diagram created by Claude Code on 2026-02-24*
