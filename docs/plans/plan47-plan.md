# Plan #47 — PLAN (theo `plan47-spec.md` v1) — XONG 28/09/2026

| Pha | Làm gì                                                                                                                                                                    | Cổng                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| P1  | Vector: `scripts/conformance.ts` (bucket, JSON chuẩn tắc, hash, đánh giá, delta, regex, mặc định) + `tests/conformance.test.ts` giữ tệp không trôi                        | test `@udp/flag-evaluator`                      |
| P2  | Lõi Python `udp_openfeature.evaluator`: `jsvalue`, `snapshot`, `hashing`, `regex_compat` (parser ECMAScript), `semver`, `conditions`, `prepare`, `evaluate`, `changefeed` | `tests/test_conformance.py`                     |
| P3  | `regexSyntaxIssue`: ngữ pháp khả chuyển (không `\p{…}`, không cờ nội tuyến, tên nhóm ASCII không trùng) — D-P35                                                           | test `@udp/shared-types`, `regex-safety` của S2 |
| P4  | Provider: `sse`, `cancel`, `transport`, `store`, `sync`, `stats`, `labels`, `metrics`, `provider`, `_internals`; test port từ bản Node + test đầu-cuối HTTP               | pytest cả bộ                                    |
| P5  | `packages/openfeature-provider/tests/python-parity.test.ts` + `sdks/python/tests/fixtures/parity_driver.py`: Service 2 thật, I15c, I26                                    | vitest tệp đó                                   |
| P6  | Cổng Python (ruff, format, mypy strict) trong `pyproject.toml`; CI job `python`, job `test` dựng `.venv`; thiết kế §6.5, §6.6, §6.8, §13.5, §16, D-P35; bàn giao; commit  | design-lint, typecheck, lint, prettier          |
