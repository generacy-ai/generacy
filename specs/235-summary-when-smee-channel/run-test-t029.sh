#!/bin/bash
# Manual Test T029: Create New Webhooks
# This script executes the test procedure for webhook creation

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

TEST_REPO_OWNER="generacy-ai"
TEST_REPO_NAME="humancy"
SMEE_URL="${SMEE_CHANNEL_URL:-https://smee.io/mNhnxyK56d9qkZo}"

echo -e "${YELLOW}=== Manual Test T029: Create New Webhooks ===${NC}\n"

# Step 1: Check current webhooks
echo -e "${YELLOW}Step 1: Checking current webhooks on ${TEST_REPO_OWNER}/${TEST_REPO_NAME}${NC}"
WEBHOOKS=$(gh api /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/hooks)
echo "$WEBHOOKS" | jq -r '.[] | "ID: \(.id), Active: \(.active), URL: \(.config.url)"'

# Find webhook ID matching Smee URL
WEBHOOK_ID=$(echo "$WEBHOOKS" | jq -r --arg url "$SMEE_URL" '.[] | select(.config.url == $url) | .id' | head -1)

if [ -z "$WEBHOOK_ID" ]; then
    echo -e "${GREEN}✓ No webhook exists - ready to test creation${NC}\n"
else
    echo -e "${RED}⚠ Webhook already exists (ID: $WEBHOOK_ID)${NC}"
    echo -e "${YELLOW}To test creation, delete it first:${NC}"
    echo "  gh api DELETE /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/hooks/$WEBHOOK_ID"
    echo ""
    read -p "Delete webhook now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Deleting webhook ID: $WEBHOOK_ID${NC}"
        gh api DELETE /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/hooks/$WEBHOOK_ID
        echo -e "${GREEN}✓ Webhook deleted${NC}\n"
        sleep 1

        # Verify deletion
        WEBHOOKS_AFTER=$(gh api /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/hooks)
        REMAINING=$(echo "$WEBHOOKS_AFTER" | jq -r --arg url "$SMEE_URL" '.[] | select(.config.url == $url) | .id')
        if [ -z "$REMAINING" ]; then
            echo -e "${GREEN}✓ Verified: No webhook with Smee URL exists${NC}\n"
        else
            echo -e "${RED}✗ Error: Webhook still exists after deletion${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}Skipping webhook deletion - will test 'skip' behavior instead${NC}\n"
    fi
fi

# Step 2: Verify environment
echo -e "${YELLOW}Step 2: Verifying environment variables${NC}"
echo "SMEE_CHANNEL_URL: ${SMEE_CHANNEL_URL}"
echo "MONITORED_REPOS: ${MONITORED_REPOS}"
echo ""

if [ -z "$SMEE_CHANNEL_URL" ]; then
    echo -e "${RED}✗ SMEE_CHANNEL_URL not set${NC}"
    exit 1
fi

if [ -z "$MONITORED_REPOS" ]; then
    echo -e "${RED}✗ MONITORED_REPOS not set${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Environment configured${NC}\n"

# Step 3: Build project (optional - skip if already built)
echo -e "${YELLOW}Step 3: Building project${NC}"
read -p "Build project now? (recommended if code changed) (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd /workspaces/generacy
    echo "Running pnpm build..."
    pnpm build
    echo -e "${GREEN}✓ Build complete${NC}\n"
else
    echo -e "${YELLOW}Skipping build - using existing build${NC}\n"
fi

# Step 4: Start orchestrator
echo -e "${YELLOW}Step 4: Starting orchestrator with label monitor${NC}"
echo -e "${YELLOW}Watch for these log entries:${NC}"
echo "  1. 'Configuring GitHub webhooks...'"
echo "  2. 'Created new webhook for repository' (if webhook was deleted)"
echo "  3. 'Webhook auto-configuration complete' with created: 1 (or skipped: 7)"
echo "  4. 'Orchestrator server ready and listening'"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the orchestrator after verification${NC}"
echo ""
read -p "Start orchestrator now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd /workspaces/generacy
    pnpm exec generacy orchestrator --label-monitor
else
    echo -e "${YELLOW}Skipping orchestrator start${NC}"
    echo -e "${YELLOW}To start manually, run:${NC}"
    echo "  cd /workspaces/generacy && pnpm exec generacy orchestrator --label-monitor"
fi

# Note: Steps 5-7 are manual verification steps
echo ""
echo -e "${YELLOW}=== Post-Test Verification ===${NC}"
echo "After running the orchestrator, verify:"
echo "1. Check logs for 'Webhook auto-configuration complete'"
echo "2. Run: gh api /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/hooks"
echo "3. Verify webhook exists with:"
echo "   - URL: $SMEE_URL"
echo "   - Active: true"
echo "   - Events: includes 'issues'"
echo ""
echo -e "${GREEN}Test complete!${NC}"
