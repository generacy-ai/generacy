#!/bin/bash
set -euo pipefail

# T010: Verify preview publish workflow executes
# Run this script after merging PR #275 to develop.
#
# Prerequisites:
#   - gh CLI authenticated (gh auth status)
#   - oras CLI installed (brew install oras / go install oras.land/oras/cmd/oras@latest)
#
# This script checks:
#   1. publish-preview.yml triggered on push to develop
#   2. publish-devcontainer-feature job succeeded (oras push to GHCR)
#   3. Preview OCI artifact exists at ghcr.io/generacy-ai/generacy/generacy:preview

REPO="generacy-ai/generacy"
WORKFLOW="publish-preview.yml"
FEATURE_REF="ghcr.io/generacy-ai/generacy/generacy:preview"

echo "=== T010: Verify preview publish workflow ==="
echo ""

# Step 1: Check that publish-preview.yml ran on develop
echo "--- Step 1: Check workflow trigger ---"
LATEST_RUN=$(gh run list \
  --repo "$REPO" \
  --workflow "$WORKFLOW" \
  --branch develop \
  --limit 1 \
  --json databaseId,status,conclusion,createdAt \
  --jq '.[0]')

if [ -z "$LATEST_RUN" ] || [ "$LATEST_RUN" = "null" ]; then
  echo "FAIL: No runs found for $WORKFLOW on develop"
  exit 1
fi

RUN_ID=$(echo "$LATEST_RUN" | jq -r '.databaseId')
STATUS=$(echo "$LATEST_RUN" | jq -r '.status')
CONCLUSION=$(echo "$LATEST_RUN" | jq -r '.conclusion')
CREATED=$(echo "$LATEST_RUN" | jq -r '.createdAt')

echo "  Run ID:     $RUN_ID"
echo "  Status:     $STATUS"
echo "  Conclusion: $CONCLUSION"
echo "  Created:    $CREATED"

if [ "$STATUS" != "completed" ]; then
  echo "WARN: Workflow still running. Check back later or run:"
  echo "  gh run watch $RUN_ID --repo $REPO"
  exit 1
fi

if [ "$CONCLUSION" != "success" ]; then
  echo "FAIL: Workflow completed with conclusion: $CONCLUSION"
  echo "  View logs: gh run view $RUN_ID --repo $REPO --log"
  exit 1
fi

echo "  PASS: Workflow completed successfully"
echo ""

# Step 2: Check devcontainer feature job specifically
echo "--- Step 2: Check devcontainer feature job ---"
FEATURE_JOB=$(gh run view "$RUN_ID" \
  --repo "$REPO" \
  --json jobs \
  --jq '.jobs[] | select(.name | contains("publish-devcontainer-feature")) | {name: .name, status: .status, conclusion: .conclusion}')

if [ -z "$FEATURE_JOB" ] || [ "$FEATURE_JOB" = "null" ]; then
  echo "FAIL: No publish-devcontainer-feature job found in run $RUN_ID"
  exit 1
fi

JOB_NAME=$(echo "$FEATURE_JOB" | jq -r '.name')
JOB_CONCLUSION=$(echo "$FEATURE_JOB" | jq -r '.conclusion')

echo "  Job:        $JOB_NAME"
echo "  Conclusion: $JOB_CONCLUSION"

if [ "$JOB_CONCLUSION" = "skipped" ]; then
  echo "FAIL: Devcontainer feature job was skipped"
  echo "  This may indicate the has_changesets gate was not removed."
  exit 1
fi

if [ "$JOB_CONCLUSION" != "success" ]; then
  echo "FAIL: Devcontainer feature job concluded: $JOB_CONCLUSION"
  echo "  View logs: gh run view $RUN_ID --repo $REPO --log"
  exit 1
fi

echo "  PASS: Devcontainer feature published via oras"
echo ""

# Step 3: Validate the OCI artifact exists
echo "--- Step 3: Validate preview artifact ---"
echo "  Fetching manifest for $FEATURE_REF ..."

if oras manifest fetch "$FEATURE_REF" > /dev/null 2>&1; then
  echo "  PASS: Preview artifact exists"
  echo ""
  echo "  Manifest:"
  oras manifest fetch "$FEATURE_REF" | jq .
else
  echo "FAIL: Could not fetch manifest for $FEATURE_REF"
  echo "  The artifact may not exist yet, or the package may be private."
  echo "  If private, complete T011 first (set GHCR visibility to public)."
  exit 1
fi

echo ""
echo "=== T010: All checks passed ==="
echo ""
echo "Next steps:"
echo "  T011: Set GHCR package visibility to public"
echo "    -> https://github.com/orgs/generacy-ai/packages/container/generacy%2Fgeneracy/settings"
echo "  T012: Verify public pull"
echo "    -> ./verify-public-pull.sh"
