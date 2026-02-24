#!/bin/bash
# Test T030: Skip Existing Webhooks
# Verifies that orchestrator correctly skips existing webhooks on restart

set -e

FEATURE_DIR="/workspaces/generacy/specs/235-summary-when-smee-channel"
PROJECT_DIR="/workspaces/generacy"
TEST_REPO="generacy-ai/humancy"
EXPECTED_WEBHOOK_ID=597807891

echo "=========================================="
echo "Test T030: Skip Existing Webhooks"
echo "=========================================="
echo ""

# Step 1: Pre-test verification
echo "Step 1: Verifying webhook exists from T029..."
echo ""

WEBHOOK_COUNT=$(gh api "/repos/$TEST_REPO/hooks" | jq 'length')
echo "✓ Webhook count for $TEST_REPO: $WEBHOOK_COUNT"

if [ "$WEBHOOK_COUNT" -eq 0 ]; then
    echo "❌ ERROR: No webhooks found. Please run T029 first."
    exit 1
fi

WEBHOOK_INFO=$(gh api "/repos/$TEST_REPO/hooks" | jq -r '.[0] | "ID: \(.id), Active: \(.active), URL: \(.config.url), Events: \(.events | join(","))"')
echo "✓ Webhook info: $WEBHOOK_INFO"
echo ""

# Step 2: Verify environment variables
echo "Step 2: Verifying environment variables..."
echo ""

if [ -z "$SMEE_CHANNEL_URL" ]; then
    echo "❌ ERROR: SMEE_CHANNEL_URL not set"
    exit 1
fi

if [ -z "$MONITORED_REPOS" ]; then
    echo "❌ ERROR: MONITORED_REPOS not set"
    exit 1
fi

echo "✓ SMEE_CHANNEL_URL: $SMEE_CHANNEL_URL"
echo "✓ MONITORED_REPOS: $MONITORED_REPOS"
echo ""

# Count repos
REPO_COUNT=$(echo "$MONITORED_REPOS" | tr ',' '\n' | wc -l)
echo "✓ Monitoring $REPO_COUNT repositories"
echo ""

# Step 3: Start orchestrator
echo "Step 3: Starting orchestrator (press Ctrl+C to stop after verification)..."
echo ""
echo "Watch for these log entries:"
echo "  1. 'Configuring GitHub webhooks...'"
echo "  2. 'Webhook already exists and is active' (7 times)"
echo "  3. 'Webhook auto-configuration complete' with created: 0, skipped: 7"
echo "  4. 'Orchestrator server ready and listening'"
echo ""
echo "Starting in 3 seconds..."
sleep 1
echo "2..."
sleep 1
echo "1..."
sleep 1
echo ""

cd "$PROJECT_DIR"

# Capture start time
START_TIME=$(date +%s)

# Run orchestrator (will be interrupted by user)
pnpm exec generacy orchestrator --label-monitor

# Note: Script continues here only if orchestrator exits or is interrupted
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=========================================="
echo "Post-Test Verification"
echo "=========================================="
echo ""
echo "Runtime: ${ELAPSED}s"
echo ""

# Step 4: Verify no duplicate webhooks
echo "Step 4: Verifying no duplicate webhooks created..."
echo ""

WEBHOOK_COUNT_AFTER=$(gh api "/repos/$TEST_REPO/hooks" | jq 'length')
echo "✓ Webhook count after test: $WEBHOOK_COUNT_AFTER"

if [ "$WEBHOOK_COUNT_AFTER" -ne "$WEBHOOK_COUNT" ]; then
    echo "❌ ERROR: Webhook count changed! Expected $WEBHOOK_COUNT, got $WEBHOOK_COUNT_AFTER"
    exit 1
fi

WEBHOOK_INFO_AFTER=$(gh api "/repos/$TEST_REPO/hooks" | jq -r '.[0] | "ID: \(.id), Active: \(.active), URL: \(.config.url), Events: \(.events | join(","))"')
echo "✓ Webhook info after: $WEBHOOK_INFO_AFTER"

if [ "$WEBHOOK_INFO" != "$WEBHOOK_INFO_AFTER" ]; then
    echo "⚠️  WARNING: Webhook properties changed!"
    echo "   Before: $WEBHOOK_INFO"
    echo "   After:  $WEBHOOK_INFO_AFTER"
fi

echo ""
echo "=========================================="
echo "Test T030 Checklist"
echo "=========================================="
echo ""
echo "Verify the following from the logs above:"
echo ""
echo "  [ ] Log shows: 'Configuring GitHub webhooks...'"
echo "  [ ] Log shows: 'Webhook already exists and is active' (7 times)"
echo "  [ ] Log shows: 'Webhook auto-configuration complete'"
echo "  [ ] Summary shows: total: 7"
echo "  [ ] Summary shows: created: 0"
echo "  [ ] Summary shows: skipped: 7"
echo "  [ ] Summary shows: reactivated: 0"
echo "  [ ] Summary shows: failed: 0"
echo "  [ ] Log shows: 'Orchestrator server ready and listening'"
echo "  [ ] No ERROR or WARN level logs about webhooks"
echo "  [ ] Webhook count unchanged: $WEBHOOK_COUNT"
echo "  [ ] Webhook properties unchanged"
echo ""
echo "If all checks pass, mark T030 as DONE in tasks.md"
echo ""
