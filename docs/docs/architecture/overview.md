---
sidebar_position: 1
---

# Architecture Overview

Generacy is an agentic development platform built on three core components: Agency, Humancy, and Generacy (the orchestration layer). This document provides a comprehensive overview of the system architecture.

## The Triad

The Generacy ecosystem is built around three interconnected components:

```mermaid
graph TB
    subgraph "The Triad"
        Agency[Agency<br/>Agent Enhancement]
        Humancy[Humancy<br/>Human Oversight]
        Generacy[Generacy<br/>Orchestration]
    end

    Agency <--> Humancy
    Humancy <--> Generacy
    Generacy <--> Agency

    Dev[Developer] --> Agency
    Dev --> Humancy

    Generacy --> GitHub[GitHub]
    Generacy --> Jira[Jira]
    Generacy --> Slack[Slack]
```

### Agency

Agency is the local agent enhancement layer that extends AI coding assistants with:

- **MCP Tools** - Custom tools via Model Context Protocol
- **Context Providers** - Project-aware context injection
- **Plugins** - Extensible tool system

Agency runs entirely locally and requires no external services.

### Humancy

Humancy brings humans into the agentic loop with:

- **Review Gates** - Pause points for human approval
- **Commands** - Human-triggered workflow actions
- **Audit Trail** - Complete decision history

Humancy ensures human oversight of AI-assisted development.

### Generacy

Generacy orchestrates at scale:

- **Job Queue** - Distributed task management
- **Workflow Engine** - Multi-step workflow execution
- **Integrations** - External service connections

## System Architecture

### High-Level View

```mermaid
flowchart TB
    subgraph External["External Services"]
        GitHub[GitHub]
        Jira[Jira]
        Slack[Slack]
    end

    subgraph Generacy["Generacy Platform"]
        subgraph Orchestrator["Orchestrator"]
            API[REST API]
            Webhooks[Webhook Handler]
            Scheduler[Scheduler]
        end

        subgraph Queue["Job Queue"]
            Redis[(Redis)]
            BullMQ[BullMQ]
        end

        subgraph Workers["Workers"]
            W1[Worker 1]
            W2[Worker 2]
            Wn[Worker N]
        end

        subgraph Local["Local Tools"]
            Agency[Agency]
            Humancy[Humancy]
        end
    end

    subgraph Storage["Storage"]
        DB[(PostgreSQL)]
        S3[(Artifacts)]
    end

    External <--> Webhooks
    API <--> External
    Orchestrator --> Queue
    Queue --> Workers
    Workers --> Local
    Orchestrator --> DB
    Workers --> S3
```

### Component Interaction

```mermaid
sequenceDiagram
    participant User
    participant GitHub
    participant Orchestrator
    participant Queue
    participant Worker
    participant Agency
    participant Humancy

    User->>GitHub: Create Issue
    GitHub->>Orchestrator: Webhook Event
    Orchestrator->>Queue: Create Job
    Queue->>Worker: Assign Job
    Worker->>Agency: Process Issue
    Agency->>Agency: Generate Spec
    Agency->>Humancy: Request Review
    Humancy->>User: Notification
    User->>Humancy: Approve
    Humancy->>Worker: Continue
    Worker->>Agency: Implement
    Agency->>GitHub: Create PR
    Worker->>Orchestrator: Job Complete
```

## Data Flow

### Issue Processing Flow

```mermaid
flowchart LR
    subgraph Input
        Issue[GitHub Issue]
    end

    subgraph Processing
        Spec[Specification]
        Plan[Planning]
        Tasks[Task Generation]
        Impl[Implementation]
    end

    subgraph Output
        PR[Pull Request]
    end

    subgraph Gates["Review Gates"]
        G1[Spec Review]
        G2[Plan Review]
        G3[Code Review]
    end

    Issue --> Spec
    Spec --> G1
    G1 -->|Approved| Plan
    Plan --> G2
    G2 -->|Approved| Tasks
    Tasks --> Impl
    Impl --> G3
    G3 -->|Approved| PR
```

### Message Flow

```mermaid
flowchart TB
    subgraph Channels["Communication Channels"]
        MCP[MCP Protocol]
        REST[REST API]
        WS[WebSocket]
        Webhook[Webhooks]
    end

    subgraph Components
        Agent[AI Agent]
        Agency[Agency]
        Humancy[Humancy]
        Generacy[Generacy]
        External[External Services]
    end

    Agent <-->|MCP| Agency
    Agent <-->|MCP| Humancy
    Agency <-->|Internal| Humancy
    Humancy <-->|REST| Generacy
    Generacy <-->|REST/WS| External
    External -->|Webhook| Generacy
```

## Deployment Architecture

### Local Development (Level 1-3)

```mermaid
graph TB
    subgraph Developer Machine
        Agent[AI Agent]
        Agency[Agency]
        Humancy[Humancy]

        subgraph "Local Services (Level 3)"
            Orchestrator[Orchestrator]
            Worker[Worker]
            Redis[(Redis)]
            SQLite[(SQLite)]
        end
    end

    Agent --> Agency
    Agent --> Humancy
    Humancy --> Orchestrator
    Orchestrator --> Redis
    Worker --> Redis
    Orchestrator --> SQLite
```

### Cloud Deployment (Level 4)

```mermaid
graph TB
    subgraph Cloud["Cloud Infrastructure"]
        subgraph "Control Plane"
            LB[Load Balancer]
            API1[Orchestrator 1]
            API2[Orchestrator 2]
        end

        subgraph "Data Plane"
            W1[Worker Pool 1]
            W2[Worker Pool 2]
        end

        subgraph "Data Layer"
            Redis[(Redis Cluster)]
            PG[(PostgreSQL)]
            S3[(S3 Artifacts)]
        end
    end

    subgraph "Developer Machines"
        Dev1[Developer 1]
        Dev2[Developer 2]
    end

    Dev1 & Dev2 --> LB
    LB --> API1 & API2
    API1 & API2 --> Redis
    API1 & API2 --> PG
    W1 & W2 --> Redis
    W1 & W2 --> S3
```

## Key Design Decisions

### 1. MCP Protocol for Agent Communication

We use the Model Context Protocol (MCP) for agent communication because:

- Standardized protocol adopted by multiple AI assistants
- Supports streaming and bidirectional communication
- Type-safe tool definitions
- Growing ecosystem support

### 2. Redis + BullMQ for Job Queue

We chose Redis with BullMQ because:

- Proven reliability at scale
- Rich feature set (priorities, delays, retries)
- Good observability tools
- Easy local development

### 3. PostgreSQL for State

PostgreSQL provides:

- ACID compliance for workflow state
- JSON support for flexible schemas
- Excellent tooling ecosystem
- Horizontal scaling options

### 4. Progressive Adoption

The architecture supports progressive adoption:

- **Level 1**: Agency only (zero external dependencies)
- **Level 2**: Add Humancy (still fully local)
- **Level 3**: Add local orchestration
- **Level 4**: Scale to cloud

## Security Model

See [Security Documentation](/docs/architecture/security) for detailed security architecture.

## Next Steps

- [Contracts](/docs/architecture/contracts) - Data contracts and schemas
- [Security](/docs/architecture/security) - Security model
