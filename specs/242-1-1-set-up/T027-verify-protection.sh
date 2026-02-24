#!/bin/bash
# T027: Verify branch protection for generacy/main
# This script verifies that branch protection rules are properly configured

set -e

REPO="generacy-ai/generacy"
BRANCH="main"

echo "🔍 Verifying branch protection for ${REPO}/${BRANCH}..."
echo ""

# Fetch branch protection settings
PROTECTION=$(gh api "/repos/${REPO}/branches/${BRANCH}/protection" 2>&1)

if [ $? -eq 0 ]; then
  echo "✅ Branch protection is enabled"
  echo ""

  # Parse and display key settings
  echo "Current protection rules:"
  echo "$PROTECTION" | jq '{
    "PR required": .required_pull_request_reviews != null,
    "Approvals required": .required_pull_request_reviews.required_approving_review_count,
    "Dismiss stale reviews": .required_pull_request_reviews.dismiss_stale_reviews,
    "Status checks required": .required_status_checks != null,
    "Required checks": .required_status_checks.checks[].context,
    "Strict status checks": .required_status_checks.strict,
    "Conversation resolution": .required_conversation_resolution.enabled,
    "Force pushes allowed": .allow_force_pushes.enabled,
    "Deletions allowed": .allow_deletions.enabled,
    "Admins enforced": .enforce_admins.enabled
  }'

  echo ""
  echo "✅ Branch protection verification complete"
else
  echo "❌ Branch protection is NOT enabled"
  echo ""
  echo "To enable branch protection, run:"
  echo "  ./T027-setup-branch-protection.sh"
  exit 1
fi
