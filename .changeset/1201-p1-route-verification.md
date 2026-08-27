---
---

P1 route plumbing end-to-end verification (#1201). Tests, golden fixture, and a
docs note only — no production behavior change. Verifies the P1 gateway
routing stack (#1198 route resolution + gateway `CLAUDE_CONFIG_DIR`, #1199
route-aware session invalidation, #1200 validate/doctor surfaces) works
end-to-end and that subscription launches remain byte-for-byte unchanged.
