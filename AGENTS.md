# Project Instructions

Use the installed TypeSafe skill for TypeSafe/Jev work in this project, including
incubator judgment design, architecture, implementation, and verification. Read
`.agents/skills/typesafe-ai/SKILL.md` and the relevant live TypeSafe documentation
before designing or changing an integration.

Keep deterministic acceptance policy in the incubator. Jev supplies typed semantic
judgments; evidence collection and execution remain the controller's responsibility.
The current API accepts text only. Convert screenshot inspection into explicit
observations with evidence references; do not send image data as supported input.

The local API credential is `TYPESAFE_API_KEY` in the Git-ignored root `.env`.
Load it explicitly for local server-side calls. Never print the value, commit it,
include it in evidence bundles, or expose it to browser code.

Continue following the repository guidance in `README.md` and `DAILY_SEED.md`.
