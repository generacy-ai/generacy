# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 20:44

### Q1: Outcome Data Source
**Context**: The OutcomeEvaluator needs to determine if a decision was 'correct', but the spec doesn't clarify where outcome data comes from or how correctness is defined.
**Question**: How will outcome data be provided to the system? Will outcomes be manually entered by users, imported from external systems, or inferred from subsequent decisions?
**Options**:
- A: Manual entry - users explicitly mark decisions as successful/failed
- B: External import - outcomes come from connected business systems
- C: Inference - system infers outcomes from subsequent user behavior
- D: Hybrid - support multiple outcome data sources

**Answer**: *Pending*

### Q2: Counterfactual Method
**Context**: Counterfactual analysis ('would baseline have worked?') is a core feature but the methodology for answering this is undefined.
**Question**: How should counterfactual analysis determine if an alternative option 'would have worked'? Should it use historical pattern matching, domain expert rules, or is this left as a manual assessment?
**Options**:
- A: Historical patterns - compare to similar past decisions with known outcomes
- B: Rule-based - domain experts define success criteria per decision type
- C: Manual assessment - humans evaluate counterfactuals retrospectively
- D: Confidence estimation - provide likelihood scores without definitive answers

**Answer**: *Pending*

### Q3: Storage Architecture
**Context**: The spec defines interfaces but doesn't specify how attributions and metrics should be persisted.
**Question**: Should the attribution engine include its own persistence layer, or will it integrate with an external storage system defined elsewhere?
**Options**:
- A: Self-contained - include repository interfaces and in-memory/file storage
- B: External integration - expect storage adapters to be injected
- C: Pure calculation - stateless engine, caller handles all persistence

**Answer**: *Pending*

### Q4: Partial Success Handling
**Context**: The spec mentions 'success/failure/partial' outcomes but doesn't define how partial success affects attribution calculations.
**Question**: How should partial success be handled in attribution? Should partial outcomes be weighted, treated as binary at a threshold, or tracked separately?
**Options**:
- A: Weighted scoring - partial success contributes proportionally (e.g., 0.7)
- B: Threshold-based - partial above X% counts as success, below as failure
- C: Separate tracking - partial outcomes excluded from main metrics but tracked separately

**Answer**: *Pending*

### Q5: MetricsPeriod Definition
**Context**: The MetricsAggregator uses 'MetricsPeriod' but the spec doesn't define what time periods should be supported.
**Question**: What time periods should MetricsPeriod support for metrics aggregation?
**Options**:
- A: Fixed periods only - day, week, month, quarter, year
- B: Custom ranges - arbitrary start/end dates
- C: Both fixed and custom - predefined periods plus custom date ranges

**Answer**: *Pending*

