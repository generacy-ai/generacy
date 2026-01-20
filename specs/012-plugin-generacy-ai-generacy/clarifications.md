# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-20 03:30

### Q1: Plugin Architecture Integration
**Context**: The plugin depends on #2 (Generacy Core Package). Understanding how plugins integrate with Core affects the entire implementation approach - whether we use a plugin registry, dependency injection, or direct imports.
**Question**: How should this plugin integrate with Generacy Core? Should it implement a specific plugin interface from Core, or is it a standalone package that Core consumes?
**Options**:
- A: Implement a PluginInterface defined in Core package
- B: Standalone package with exports that Core imports directly
- C: Use a plugin registry/discovery pattern from Core

**Answer**: *Pending*

### Q2: Webhook Receiver Architecture
**Context**: Webhooks require an HTTP endpoint to receive GitHub events. This affects infrastructure requirements and deployment complexity.
**Question**: How should webhooks be received? Does Generacy have an existing webhook receiver, or should this plugin include its own HTTP server component?
**Options**:
- A: Plugin includes its own HTTP server for webhook endpoints
- B: Rely on external webhook receiver that forwards events to the plugin
- C: Integrate with Generacy's existing server infrastructure (if any)

**Answer**: *Pending*

### Q3: Authentication Strategy
**Context**: The config shows support for both PAT tokens and GitHub App authentication. GitHub Apps provide better security and rate limits but require more setup.
**Question**: Which authentication method should be the primary implementation? Should both be supported from the start, or should we prioritize one?
**Options**:
- A: PAT token only (simpler, implement first)
- B: GitHub App only (better for production)
- C: Both from the start with a common interface

**Answer**: *Pending*

### Q4: Event Streaming Mechanism
**Context**: Real-time event streaming can be implemented via webhooks (push) or polling (pull). This affects latency, reliability, and resource usage.
**Question**: Should event streaming use webhooks (push), polling (pull), or a hybrid approach?
**Options**:
- A: Webhooks only (real-time but requires public endpoint)
- B: Polling only (works anywhere but has latency)
- C: Hybrid - webhooks when available, polling as fallback

**Answer**: *Pending*

### Q5: Initial Scope MVP
**Context**: The spec lists many features. Understanding the minimum viable scope helps prioritize implementation and deliver value faster.
**Question**: For the initial implementation, which features are MVP (must-have) vs. future enhancements?
**Options**:
- A: All features listed are MVP - implement everything
- B: Core CRUD + labels only - webhooks/streaming are future
- C: CRUD + webhooks MVP - templates/PR linking are future

**Answer**: *Pending*

