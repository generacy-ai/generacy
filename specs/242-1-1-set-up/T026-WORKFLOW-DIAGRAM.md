# T026 Workflow Diagram

## 📊 Visual Guide: Branch Protection Setup

```
┌─────────────────────────────────────────────────────────────────────┐
│                    T026: Enable Branch Protection                    │
│                        for agency/main branch                        │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                        ┌─────────────────┐
                        │  Prerequisites  │
                        │   Check List    │
                        └─────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
            ┌──────────┐  ┌──────────┐  ┌──────────┐
            │ T020     │  │ T012     │  │ GitHub   │
            │ Release  │  │ CI       │  │ Admin    │
            │ Workflow │  │ Workflow │  │ Access   │
            └──────────┘  └──────────┘  └──────────┘
                    │             │             │
                    └─────────────┴─────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │   Choose Setup Method   │
                    └─────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
        ┌───────────────────────┐   ┌───────────────────────┐
        │  Option 1: Automated  │   │  Option 2: Manual UI  │
        │  (GitHub API Script)  │   │  (GitHub Settings)    │
        └───────────────────────┘   └───────────────────────┘
                    │                           │
                    │                           │
        ┌───────────▼───────────┐   ┌──────────▼──────────┐
        │                       │   │                      │
        │  Run Setup Script:    │   │  Open GitHub:        │
        │  T026-setup-branch-   │   │  github.com/         │
        │  protection.sh        │   │  generacy-ai/agency/ │
        │                       │   │  settings/branches   │
        │  ├─ Set PR required   │   │                      │
        │  ├─ Set approvals: 1  │   │  Configure:          │
        │  ├─ Add status checks │   │  ├─ PR required      │
        │  ├─ Block force push  │   │  ├─ Approvals: 1     │
        │  ├─ Block deletions   │   │  ├─ Status checks    │
        │  └─ Allow admin bypass│   │  ├─ Force push block │
        │                       │   │  ├─ Deletion block   │
        │                       │   │  └─ Admin bypass     │
        └───────────────────────┘   └──────────────────────┘
                    │                           │
                    └───────────┬───────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Verify Setup        │
                    │   T026-verify-        │
                    │   protection.sh       │
                    └───────────────────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
            ┌──────────┐ ┌──────────┐ ┌──────────┐
            │ PR Rules │ │ Status   │ │ Force    │
            │ Verified │ │ Checks   │ │ Push     │
            │          │ │ Verified │ │ Blocked  │
            └──────────┘ └──────────┘ └──────────┘
                    │           │           │
                    └───────────┴───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Test Protection     │
                    └───────────────────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼                       ▼
        ┌──────────────────────┐  ┌──────────────────────┐
        │  Test 1: Direct Push │  │  Test 2: PR Workflow │
        │  (Should FAIL)       │  │  (Should SUCCEED)    │
        │                      │  │                      │
        │  git push origin main│  │  Create test branch  │
        │  ❌ Rejected!        │  │  Push & create PR    │
        │  ✅ Protection works │  │  ✅ PR created       │
        └──────────────────────┘  └──────────────────────┘
                    │                       │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  Document Completion  │
                    │  T026-COMPLETION.md   │
                    └───────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Mark Task DONE      │
                    │   in tasks.md         │
                    └───────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Proceed to T027     │
                    │   (generacy repo)     │
                    └───────────────────────┘
```

---

## 🔄 Protection Rules Applied

```
┌──────────────────────────────────────────────────────────────┐
│                        main branch                            │
│                    (Protected Branch)                         │
└──────────────────────────────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ Pull Request    │  │ Status Checks   │  │ Conversation     │
│ Required        │  │ Required        │  │ Resolution       │
│                 │  │                 │  │ Required         │
│ ✓ 1 approval   │  │ ✓ lint         │  │                  │
│ ✓ Dismiss stale│  │ ✓ test         │  │ ✓ All threads   │
│   reviews      │  │ ✓ build        │  │   resolved      │
└─────────────────┘  └─────────────────┘  └──────────────────┘
         │                   │                   │
         └───────────────────┴───────────────────┘
                             │
                             ▼
         ┌───────────────────────────────────────┐
         │         Additional Protections        │
         │                                       │
         │  ❌ Force pushes blocked              │
         │  ❌ Branch deletions blocked          │
         │  ✅ Admin bypass allowed (emergency)  │
         │  ✅ Fork syncing allowed             │
         └───────────────────────────────────────┘
```

---

## 🚦 Merge Flow with Protection

```
Developer Workflow:

┌──────────┐
│ develop  │
│ branch   │
└──────────┘
     │
     │ Create feature branch
     ▼
┌──────────┐
│ feature/ │
│ branch   │
└──────────┘
     │
     │ Make changes
     │ Commit
     │ Push
     ▼
┌────────────────┐
│ Create PR to   │◄──────────────┐
│ main branch    │               │
└────────────────┘               │
     │                           │
     │ Automatically triggers    │
     ▼                           │
┌────────────────┐               │
│ CI Workflow    │               │
│ Runs           │               │
│                │               │
│ ├─ lint        │──┐            │
│ ├─ test        │  │ Any fails? │
│ └─ build       │  │ ├─Yes ────►│ Fix issues
└────────────────┘  │            │
     │              │            │
     │ All pass     │            │
     ▼              │            │
┌────────────────┐  │            │
│ Request Review │  │            │
└────────────────┘  │            │
     │              │            │
     │ Reviewer     │            │
     │ approves     │            │
     ▼              │            │
┌────────────────┐  │            │
│ All checks ✅  │  │            │
│ - CI passed    │◄─┘            │
│ - 1 approval   │               │
│ - Conversations│               │
│   resolved     │               │
│ - Up to date   │               │
└────────────────┘               │
     │                           │
     │ Merge button enabled      │
     ▼                           │
┌────────────────┐               │
│ Merge to main  │               │
└────────────────┘               │
     │                           │
     │ Triggers release workflow │
     ▼                           │
┌────────────────┐               │
│ Changesets     │               │
│ Action Runs    │               │
│                │               │
│ Creates        │               │
│ "Version       │               │
│ Packages" PR   │               │
└────────────────┘               │
     │                           │
     │ Review & merge            │
     │ version PR                │
     ▼                           │
┌────────────────┐               │
│ Publish to npm │               │
│ with @latest   │               │
│ dist-tag       │               │
└────────────────┘               │
                                 │
     ❌ Direct Push Attempt      │
     (Without PR)                │
          │                      │
          ▼                      │
     ┌─────────┐                 │
     │ BLOCKED │                 │
     │ by      │                 │
     │ GitHub  │                 │
     └─────────┘                 │
          │                      │
          └────────────────────►─┘
          Must use PR workflow
```

---

## 🔍 Decision Tree: Setup Method

```
Start: Need to enable branch protection for agency/main

                    ┌─────────────────────┐
                    │ Do you have gh CLI  │
                    │ installed and       │
                    │ authenticated?      │
                    └─────────────────────┘
                         │         │
                      Yes│         │No
                         │         │
         ┌───────────────┘         └────────────────┐
         │                                          │
         ▼                                          ▼
┌───────────────────┐                    ┌──────────────────┐
│ Do you have jq    │                    │ Use Manual Setup │
│ installed?        │                    │ via GitHub UI    │
└───────────────────┘                    │                  │
         │         │                     │ See T026-        │
      Yes│         │No                   │ INSTRUCTIONS.md  │
         │         │                     │ Option 2         │
         ▼         │                     └──────────────────┐
┌─────────────┐    │                                        │
│ Comfortable │    │                                        │
│ with CLI?   │    │                                        │
└─────────────┘    │                                        │
    │       │      │                                        │
 Yes│       │No    │                                        │
    │       │      │                                        │
    │       └──────┴────────────────┐                      │
    │                                │                      │
    ▼                                ▼                      │
┌─────────────────────┐   ┌──────────────────┐            │
│ Use Automated Setup │   │ Use Manual Setup │            │
│ (Recommended)       │   │ via GitHub UI    │◄───────────┘
│                     │   │                  │
│ Run scripts:        │   │ Follow visual    │
│ 1. T026-setup-...sh │   │ guide in         │
│ 2. T026-verify-...sh│   │ instructions     │
│                     │   │                  │
│ ⚡ Faster (2 min)  │   │ 🖱️ Easier (5min)│
└─────────────────────┘   └──────────────────┘
         │                         │
         └────────────┬────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │ Both methods achieve   │
         │ the same result        │
         │                        │
         │ Verify with:           │
         │ T026-verify-           │
         │ protection.sh          │
         └────────────────────────┘
```

---

## 📊 Task Dependencies

```
Sequential Dependencies (Must complete in order):

T012 ──► T020 ──► T026 ──► T038 ──► T041
 │        │        │        │        │
 │        │        │        │        └──► Test stable release
 │        │        │        │             for agency
 │        │        │        │
 │        │        │        └──────────► Test preview publish
 │        │        │                     for agency
 │        │        │
 │        │        └──────────────────► Enable branch protection
 │        │                              for agency/main
 │        │
 │        └──────────────────────────► Create stable release
 │                                      workflow for agency
 │
 └───────────────────────────────────► Create CI workflow
                                        for agency

Parallel Tasks (Can run simultaneously):

┌─────────┐     ┌─────────┐     ┌─────────┐
│  T025   │     │  T026   │     │  T027   │
│ latency │     │ agency  │     │ generacy│
│ /main   │     │ /main   │     │ /main   │
└─────────┘     └─────────┘     └─────────┘
    │               │               │
    └───────────────┴───────────────┘
              │
              └─► All three repos can have
                  branch protection enabled
                  in parallel (after their
                  respective workflows are ready)
```

---

## 🎯 Success Path

```
┌────────┐
│ START  │
└────┬───┘
     │
     ▼
┌─────────────────────────┐
│ Prerequisites Met?      │
│ ✓ Admin access         │
│ ✓ gh CLI auth          │
│ ✓ CI workflow exists   │
│ ✓ Release workflow     │
└────┬────────────────────┘
     │ Yes
     ▼
┌─────────────────────────┐
│ Execute Setup           │
│ (2-5 minutes)           │
└────┬────────────────────┘
     │
     ▼
┌─────────────────────────┐
│ Verify Configuration    │
│ (1 minute)              │
└────┬────────────────────┘
     │ All checks pass
     ▼
┌─────────────────────────┐
│ Test Protection         │
│ (1-2 minutes)           │
│ ✓ Direct push fails    │
│ ✓ PR workflow works    │
└────┬────────────────────┘
     │ Tests pass
     ▼
┌─────────────────────────┐
│ Document Completion     │
│ (2-3 minutes)           │
└────┬────────────────────┘
     │
     ▼
┌─────────────────────────┐
│ Mark T026 as DONE       │
└────┬────────────────────┘
     │
     ▼
┌────────┐
│  END   │
│SUCCESS │
└────────┘

Total Time: ~10-15 minutes
```

---

## 🔗 Navigation

- **Back to Overview**: [T026-README.md](./T026-README.md)
- **Quick Start**: [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md)
- **Detailed Guide**: [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md)
- **All Documentation**: [T026-INDEX.md](./T026-INDEX.md)
