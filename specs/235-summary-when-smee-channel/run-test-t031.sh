#!/bin/bash
# Manual Test T031: Reactivate Inactive Webhooks
# This script helps automate the webhook disabling step and restart the orchestrator

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Manual Test T031: Reactivate Inactive Webhooks ===${NC}"
echo

# Check prerequisites
if [ -z "$SMEE_CHANNEL_URL" ]; then
  echo -e "${RED}ERROR: SMEE_CHANNEL_URL is not set${NC}"
  echo "Please set it with: export SMEE_CHANNEL_URL=https://smee.io/YOUR_CHANNEL"
  exit 1
fi

if [ -z "$MONITORED_REPOS" ]; then
  echo -e "${RED}ERROR: MONITORED_REPOS is not set${NC}"
  echo "Please set it with: export MONITORED_REPOS=owner/repo"
  exit 1
fi

echo -e "${GREEN}Environment variables:${NC}"
echo "  SMEE_CHANNEL_URL: $SMEE_CHANNEL_URL"
echo "  MONITORED_REPOS: $MONITORED_REPOS"
echo

# Parse repository
IFS=',' read -ra REPOS <<< "$MONITORED_REPOS"
FIRST_REPO="${REPOS[0]}"
IFS='/' read -ra REPO_PARTS <<< "$FIRST_REPO"
OWNER="${REPO_PARTS[0]}"
REPO="${REPO_PARTS[1]}"

if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
  echo -e "${RED}ERROR: Invalid repository format. Expected owner/repo${NC}"
  exit 1
fi

echo -e "${GREEN}Testing with repository: ${OWNER}/${REPO}${NC}"
echo

# Step 1: Find webhook matching the Smee URL
echo -e "${YELLOW}Step 1: Finding webhook matching Smee URL...${NC}"
WEBHOOK_DATA=$(gh api "/repos/${OWNER}/${REPO}/hooks" | jq --arg url "$SMEE_CHANNEL_URL" '.[] | select(.config.url | ascii_downcase == ($url | ascii_downcase))')

if [ -z "$WEBHOOK_DATA" ]; then
  echo -e "${RED}ERROR: No webhook found matching Smee URL${NC}"
  echo "Please run T029 first to create a webhook, or check your SMEE_CHANNEL_URL"
  exit 1
fi

WEBHOOK_ID=$(echo "$WEBHOOK_DATA" | jq -r '.id')
WEBHOOK_ACTIVE=$(echo "$WEBHOOK_DATA" | jq -r '.active')

echo "  Webhook ID: $WEBHOOK_ID"
echo "  Current status: $([ "$WEBHOOK_ACTIVE" == "true" ] && echo "active" || echo "inactive")"
echo

# Step 2: Disable webhook if currently active
if [ "$WEBHOOK_ACTIVE" == "true" ]; then
  echo -e "${YELLOW}Step 2: Disabling webhook...${NC}"
  gh api -X PATCH "/repos/${OWNER}/${REPO}/hooks/${WEBHOOK_ID}" -F active=false > /dev/null
  echo -e "${GREEN}  ✓ Webhook disabled${NC}"

  # Verify disabled
  UPDATED=$(gh api "/repos/${OWNER}/${REPO}/hooks/${WEBHOOK_ID}" | jq -r '.active')
  if [ "$UPDATED" == "false" ]; then
    echo -e "${GREEN}  ✓ Verified: webhook is now inactive${NC}"
  else
    echo -e "${RED}  ✗ ERROR: Failed to disable webhook${NC}"
    exit 1
  fi
else
  echo -e "${YELLOW}Step 2: Webhook is already inactive${NC}"
  echo -e "${GREEN}  ✓ Ready for reactivation test${NC}"
fi
echo

# Step 3: Restart orchestrator
echo -e "${YELLOW}Step 3: Starting orchestrator...${NC}"
echo -e "${YELLOW}Watch for these log messages:${NC}"
echo "  1. 'Configuring GitHub webhooks...'"
echo "  2. 'action: reactivated' with webhook ID"
echo "  3. 'reactivated: 1' in summary"
echo
echo -e "${YELLOW}Press Ctrl+C to stop when done testing${NC}"
echo
echo -e "${GREEN}Starting orchestrator in 3 seconds...${NC}"
sleep 3

# Navigate to project root and start orchestrator
cd /workspaces/generacy
pnpm exec generacy orchestrator --label-monitor

# Note: Script will be interrupted by Ctrl+C when user stops orchestrator
# The verification steps should be done manually after restart
