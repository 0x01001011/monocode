# Reason run overview

- Task: design multi-PR / stacked-PR tracking for MonoCode chats (UX + UI + data model)
- Domain: software (product UI + data model) · judges: 3 (designer, frontend+Rust engineer, stacked-PR power user) · Latin-square label order for position-bias control
- Rounds run: 1 of the 3 requested (a full round is 7 agents; 3 rounds would be about 21). Stopped after round 1 because the vote was unanimous.
- Winner: AB (synthesis), votes A=0 B=0 AB=3
- Key critique that drove change: turn-window attribution leaks branches between chats sharing a checkout; first-fetch stack base breaks after GitHub auto-retargets; per-tick stack traversal and compare are too expensive.
- Files: candidates.md (A, B, AB), critique.md, judge-transcripts.md, reason-results.tsv
