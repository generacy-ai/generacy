---
"@generacy-ai/generacy": patch
---

Add defensive content guard to `findClarificationComment` so stage-status
tables never surface as the clarification batch (#962).

The finder previously selected the first at-or-after `waiting-for:clarification`
comment purely by timing, with no body check. #960's symptom (a
`<!-- generacy-stage:planning -->` status table returned as the clarification
batch) was only latent because #958 stopped the engine from self-answering
inside the at-or-after window. The guard rejects candidates whose body carries
one of six stage-status prefixes (`<!-- generacy-stage:{planning,specification,
implementation}` and the legacy `<!-- speckit-stage:*` twins) at column 0,
unless the same body also carries a `<!-- generacy-stage:clarification*` override
marker. Rejected candidates are skipped and scanning continues; the finder
returns `null` only when every at-or-after candidate is rejected.
