<!--
Thanks for the PR. A few prompts to keep the diff tight and the
source-of-truth docs in sync with the code. Delete anything that
doesn't apply.
-->

## Summary

<!-- One sentence on what this changes. The diff already shows the what. -->

## Why

<!--
Two or three sentences on the motivation. A user incident? A correctness
gap? A capability the operator asked for? An upstream API change? Include
the why so reviewers can evaluate whether the approach matches the
constraint.
-->

## Source-of-truth updates

<!-- Tick what you updated. If a row applies and you didn't update it, explain why. -->

- [ ] `docs/CONFIG.md` (new / changed env var)
- [ ] `docs/COMMANDS.md` and `scripts/register-commands.js` (new / changed slash command)
- [ ] `docs/TOOLS.md` and `src/tools/index.js` (new / changed model-callable tool)
- [ ] `docs/MIGRATIONS.md` and the migration list (new SQLite or pgvector migration)
- [ ] `DATA_CONTRACTS.md` (external schema contract changed)
- [ ] `docs/DATA_SETUP.md` (fresh-deployment step changed)
- [ ] `docs/OPERATIONS.md` (new operational playbook or incident pattern)
- [ ] `ARCHITECTURE.md` (structural change worth surfacing in the long-form ref)
- [ ] `CLAUDE.md` (short-form ref worth tweaking for future agents)
- [ ] `CHANGELOG.md` Unreleased section

## Test plan

<!--
- [ ] `npm test && npm run lint` pass.
- [ ] Added a test for any new behavior. See `docs/TESTING.md > When to write a test`.
- [ ] If this is a UI / Discord-rendering change, ran the bot manually and verified the output. CI cannot verify Discord rendering — say so explicitly.
-->

## Notes for the reviewer

<!-- Anything non-obvious: tradeoffs considered, alternatives rejected, follow-ups deferred. -->
