# Persistent products

Incubators default to `lifecycle: product`. A product has a lasting mission and successive milestones. Sessions are bounded implementation increments; milestones may span many sessions. There is no product-size or session-count completion rule.

- `BRIEF.md`: purpose, audience, constraints, important decisions/lessons, revisable opportunities.
- `MILESTONE.md`: current goal and `## Done means` checklist. A legacy brief checklist is used until separated.
- Shaping/building/polishing apply to the current milestone. `done` records reviewed milestone completion, not retirement.
- The next scheduled session enters `advancing` (`DEVELOP`), selects the next worthwhile milestone and starts implementation. Repeating the completed checklist does not create progress.
- `lifecycle: explore` uses the same continuation rules but allows a creative lab to deepen or branch into a new experiment while preserving prior playable work.
- Only explicit `lifecycle: finite` rests after completion. An owner-disabled slot stays disabled.

The controller records completed goal/outcome snapshots, count and recent history in status.json. Checkbox changes do not change milestone identity. It supplies recent completions and decisions to fresh sessions. This supports continuity without an expanding procedural manual.

Completion requires a successful, well-formed independent review, milestone outcomes met, no actionable blockers and no known failing checks. Reviewer failures and missing milestone definitions cannot finish work. No-change sessions get fresh checks/review and back off if still unresolved. Checks and reviews remain fallible; none of this proves real-world adoption or subjective quality.

Keep/revert behavior, one global writer, sandbox permissions, configured models, timeouts and owner controls remain unchanged. Due-time ordering prevents registry-order starvation. Healthy products retain their existing cadence; failed/no-progress attempts back off and revisit automatically rather than requiring owner approval.

Prompt design keeps explicit initiative, constraints and useful product memory. It is informed by [OpenAI's Astra prompt guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), not a claim that any workflow is universally optimal.

Verification: `npm run build` runs real-runner fixtures with fake agents and temporary Git repos, UI contracts, live HTTP/auth smoke tests, then Vite. Fixtures cover multi-session milestones, second milestones, restart persistence, repeated-goal protection, failed reviews, no-change completion, finite vs ongoing scheduling and fair due ordering.
