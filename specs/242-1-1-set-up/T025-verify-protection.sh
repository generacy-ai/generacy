#!/bin/bash
# T025: Verify branch protection for latency/main
# This script checks if branch protection rules are correctly configured

set -e

REPO="generacy-ai/latency"
BRANCH="main"

echo "🔍 Verifying branch protection for ${REPO}/${BRANCH}..."
echo ""

# Fetch protection settings
PROTECTION=$(gh api /repos/${REPO}/branches/${BRANCH}/protection 2>&1) || {
  echo "❌ Failed to fetch branch protection settings"
  echo "This could mean:"
  echo "  - Branch protection is not enabled yet"
  echo "  - You don't have permission to view protection settings"
  echo "  - The branch doesn't exist"
  exit 1
}

# Check if we got valid JSON
if ! echo "$PROTECTION" | jq empty 2>/dev/null; then
  echo "❌ Invalid response from GitHub API"
  echo "$PROTECTION"
  exit 1
fi

echo "✅ Branch protection is enabled"
echo ""

# Detailed checks
echo "📋 Protection Rules:"
echo ""

# PR requirements
PR_REQUIRED=$(echo "$PROTECTION" | jq -r '.required_pull_request_reviews != null')
if [ "$PR_REQUIRED" = "true" ]; then
  APPROVALS=$(echo "$PROTECTION" | jq -r '.required_pull_request_reviews.required_approving_review_count // 0')
  DISMISS_STALE=$(echo "$PROTECTION" | jq -r '.required_pull_request_reviews.dismiss_stale_reviews')
  echo "  ✅ Pull request required"
  echo "     - Required approvals: $APPROVALS"
  echo "     - Dismiss stale reviews: $DISMISS_STALE"
else
  echo "  ⚠️  Pull request NOT required"
fi

# Status checks
STATUS_REQUIRED=$(echo "$PROTECTION" | jq -r '.required_status_checks != null')
if [ "$STATUS_REQUIRED" = "true" ]; then
  STRICT=$(echo "$PROTECTION" | jq -r '.required_status_checks.strict')
  CHECKS=$(echo "$PROTECTION" | jq -r '.required_status_checks.checks[]?.context // .required_status_checks.contexts[]?' | paste -sd "," -)
  echo "  ✅ Status checks required"
  echo "     - Require up-to-date branches: $STRICT"
  echo "     - Required checks: $CHECKS"

  # Verify expected checks
  if echo "$CHECKS" | grep -q "lint" && \
     echo "$CHECKS" | grep -q "test" && \
     echo "$CHECKS" | grep -q "build"; then
    echo "     ✅ All expected checks configured (lint, test, build)"
  else
    echo "     ⚠️  Missing expected checks (lint, test, build)"
  fi
else
  echo "  ⚠️  Status checks NOT required"
fi

# Conversation resolution
CONVERSATION_RESOLUTION=$(echo "$PROTECTION" | jq -r '.required_conversation_resolution.enabled // false')
if [ "$CONVERSATION_RESOLUTION" = "true" ]; then
  echo "  ✅ Conversation resolution required"
else
  echo "  ⚠️  Conversation resolution NOT required"
fi

# Admin enforcement
ENFORCE_ADMINS=$(echo "$PROTECTION" | jq -r '.enforce_admins.enabled // false')
echo "  $([ "$ENFORCE_ADMINS" = "true" ] && echo "✅" || echo "ℹ️")  Enforce for administrators: $ENFORCE_ADMINS"

# Force push protection
ALLOW_FORCE_PUSH=$(echo "$PROTECTION" | jq -r '.allow_force_pushes.enabled // false')
if [ "$ALLOW_FORCE_PUSH" = "false" ]; then
  echo "  ✅ Force pushes blocked"
else
  echo "  ⚠️  Force pushes ALLOWED"
fi

# Deletion protection
ALLOW_DELETIONS=$(echo "$PROTECTION" | jq -r '.allow_deletions.enabled // false')
if [ "$ALLOW_DELETIONS" = "false" ]; then
  echo "  ✅ Branch deletions blocked"
else
  echo "  ⚠️  Branch deletions ALLOWED"
fi

echo ""
echo "📊 Overall Status:"
echo ""

# Count issues
ISSUES=0
[ "$PR_REQUIRED" != "true" ] && ISSUES=$((ISSUES + 1))
[ "$STATUS_REQUIRED" != "true" ] && ISSUES=$((ISSUES + 1))
[ "$CONVERSATION_RESOLUTION" != "true" ] && ISSUES=$((ISSUES + 1))
[ "$ALLOW_FORCE_PUSH" = "true" ] && ISSUES=$((ISSUES + 1))
[ "$ALLOW_DELETIONS" = "true" ] && ISSUES=$((ISSUES + 1))

if [ $ISSUES -eq 0 ]; then
  echo "✅ All protection rules are correctly configured!"
  echo ""
  echo "Branch protection for ${REPO}/${BRANCH} meets all requirements."
  exit 0
else
  echo "⚠️  Found $ISSUES configuration issue(s)"
  echo ""
  echo "Please review the settings above and adjust as needed."
  echo "See T025-INSTRUCTIONS.md for detailed configuration steps."
  exit 1
fi
