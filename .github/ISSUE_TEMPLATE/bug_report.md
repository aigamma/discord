---
name: Bug report
about: Something the bot does that it shouldn't, or doesn't do that it should
labels: bug
---

## What happened

<!-- One or two sentences on the observed behavior. Include the exact text of the user-facing message if any. -->

## What you expected

<!-- One sentence on what should have happened instead. -->

## Reproduction

<!--
The exact command, channel context (DM vs guild), and any preceding turns
that set up the state. If a tool call was involved, include the tool name
and the inputs.
-->

## Bot environment

- Bot version / git commit:
- Node version (`node --version`):
- Model in use (default or `/ask model:`):
- Optional integrations live (✓ / ✗): Supabase / Voyage / DuckDB shards / web_search / web_fetch
- Output of `/health` at the time (paste the embed contents):

## Logs

<!--
If you can capture log lines from the time of the failure, paste them here.
The bot logs in JSON when stdout is not a TTY; redact secrets first.
A single failing turn typically produces a `turn completed` log line plus
any `warn` / `error` lines from the agent or a tool. Trim to the smallest
useful window.
-->

## Severity

<!--
- correctness (wrong number, hallucination, refusal that shouldn't have refused)
- reliability (crash, hang, embedder stuck)
- UX (confusing message, missing context, formatting glitch)
- security (would deserve a private report; see SECURITY.md before filing publicly)
-->
