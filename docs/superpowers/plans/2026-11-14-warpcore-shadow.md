# Warp Core shadow evaluation implementation plan

Goal: begin #160/#164 with a credential-free, nonpublishing contract for comparing agent decisions with owner-reviewed real-world cases.

Architecture: Deno-compatible pure modules beside the current functions. Policy is versioned data; an evaluator scores supplied model decisions without revealing expected labels in the model input. No deployment entrypoint or database writer is included.

Constraints: no paid requests, credentials, live writes or production enablement. Existing collection, drain, publishing and cron remain unchanged. Real-story fixtures are discovery inputs, not verified evidence or authority. This first slice does not select a production framework or prove model quality.

- [x] Add tests for hidden expected labels, missing/duplicate/unknown responses and real negative PyTorch case.
- [x] Add strict evaluation and request-envelope modules; require explicit model allowlist and output token cap.
- [x] Add real public candidate fixtures with provenance and editorial expected labels, including owner's Helion rejection.
- [x] Test locally and run existing JavaScript suite. Document unrun hosted/model and end-to-end stages.
- [x] Independent review, fix findings, commit and draft PR only.

Verification: 170 JavaScript tests and 10 timer tests passed. Legacy Python suite could not start because pytest is unavailable. Hosted execution, paid model evaluation and rendered Bluesky tests remain unrun.

## Second slice
- [x] Add test-first resumable scan/review core with fixed timestamp, terminal-page gate and atomic-save dependency.
- [x] Prevent automatic model replay after crash, timeout, malformed response or persistence conflict.
- [x] Separate unlabeled discovery input from evaluation gold labels.
- [x] Add explicit-off OpenRouter-only transport with injected fetch, usage validation, timeout and response-size bounds; no real calls.
- [x] Run final full JavaScript suite and independent review. No hosted database adapter or production cutover in this slice.

Second-slice verification: 191 JavaScript tests passed, including an offline workflow/request/transport composition test. Previous commit CI and isolated validation both passed on GitHub. No actual OpenRouter request or hosted scheduler ran.
