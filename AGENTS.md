# Project Instructions

Keep deterministic acceptance policy, evidence collection, and execution in the
incubator controller. Use the existing checks and independent reviewer for runs.

Keep the workshop freeform. Core Claude and Codex runs must use the same
controller verification; neither self-reported grades nor missing evidence may
certify completion. Kept work is not release approval. Run `npm run test:verification`
in `src/pi-pulse` for completion/controller changes and the full `npm run build`
on Linux before deployment. Report unavailable checks explicitly.

Keep local credentials in the Git-ignored root `.env`. Never print them, commit
them, include them in evidence bundles, or expose them to browser code.

Continue following the repository guidance in `README.md` and `DAILY_SEED.md`.
