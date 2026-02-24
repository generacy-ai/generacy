#!/bin/bash
# T027: Enable branch protection for generacy/main
# This script configures branch protection rules for the main branch of generacy-ai/generacy

set -e

REPO="generacy-ai/generacy"
BRANCH="main"

echo "🔒 Setting up branch protection for ${REPO}/${BRANCH}..."

# Enable branch protection with required settings
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  -f required_pull_request_reviews='{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"required_approving_review_count":1}' \
  -f required_status_checks='{"strict":true,"checks":[{"context":"lint"},{"context":"test"},{"context":"build"}]}' \
  -f enforce_admins=false \
  -f required_conversation_resolution='{"enabled":true}' \
  -f restrictions=null \
  -f allow_force_pushes='{"enabled":false}' \
  -f allow_deletions='{"enabled":false}' \
  -f block_creations='{"enabled":false}' \
  -f required_linear_history='{"enabled":false}' \
  -f allow_fork_syncing='{"enabled":true}'

echo "✅ Branch protection enabled for ${REPO}/${BRANCH}"
echo ""
echo "Protection rules configured:"
echo "  ✓ Require pull request before merging"
echo "  ✓ Require 1 approval"
echo "  ✓ Dismiss stale reviews on push"
echo "  ✓ Require status checks to pass (lint, test, build)"
echo "  ✓ Require branches to be up to date"
echo "  ✓ Require conversation resolution"
echo "  ✓ Restrict force pushes"
echo "  ✓ Allow admins to bypass (for emergency fixes)"
echo ""
echo "To verify protection rules:"
echo "  gh api /repos/${REPO}/branches/${BRANCH}/protection"
