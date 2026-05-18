# Forking Guide

This bot is MIT-licensed and explicitly designed to be forked. The original
deployment serves [Options Alchemy] (a private trading community); a fork
swaps the operator identity, the data layer, or the voice — or all three —
without re-architecting the agent loop.

This document is the consolidated landing page for forks. Companion docs:

- `docs/DATA_SETUP.md` — step-by-step hookup for the data layer.
- `docs/CONFIG.md` — every env var and its default.
- `DATA_CONTRACTS.md` — the schemas the bot expects.
- `CONTRIBUTING.md` — workflow, voice, style for code contributions.

---

## What a fork inherits and what it doesn't

The bot has three independent layers. A fork can swap any or all of them.

| Layer | What it is | Swap cost |
|---|---|---|
| **Discord wiring + agent loop + memory layer + observability + lifecycle** | The bot's core | Zero — every fork uses this unchanged |
| **Operator identity** | The system prompt's `[OPERATOR IDENTITY]` block — handle, name, community | Three env vars, no source change |
| **Voice / behavioral constraints** | The system prompt's `[BEHAVIORAL...]` block | Edit `src/prompt.js BEHAVIORAL_CONSTRAINTS` + update the assertions in `test/prompt.test.js` in the same commit |
| **Data layer** | The eight Supabase market-data tools, the DuckDB shards, the Voyage embeddings | Match the schemas in `DATA_CONTRACTS.md` (zero-source-change path) OR fork the tool files in `src/tools/` to point at your own data |

The core layer is intentionally domain-agnostic. Nothing in `src/agent.js`,
`src/memory.js`, `src/embedder.js`, `src/lifecycle.js`, or `src/healthServer.js`
mentions options trading, market data, or any specific tool. Those concerns
all live in `src/tools/*.js` and `src/prompt.js`.

---

## Choosing a fork posture

There are three common shapes a fork takes. Pick the one that matches your
ambition.

### 1. Pure-Anthropic conversational bot

The bot answers questions from the model's knowledge plus optional web
search; no live data, no semantic memory. Short-term context still works
(last N turns in the channel).

What you need:

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`.
- Optional: `OPERATOR_HANDLE`, `OPERATOR_NAME`, `COMMUNITY_NAME` to brand
  the system prompt's identity block to your community.
- Optional: `OWNER_DISCORD_USER_ID` if you want `/admin`.

What you skip:

- Supabase, Voyage, DuckDB shards. The bot starts cleanly without them.

What disables itself silently:

- The eight market-data tools (no Supabase).
- `search_chat_history` (no Voyage embeddings).
- `query_duckdb` (no shards).
- `/about` reflects the actual configured surface, so members see what
  the bot can do, not a marketing list of features it doesn't have.

Use case: a community that wants Claude as a desk-mate without needing
a domain-specific data layer.

### 2. Your-domain bot with the existing voice

Same voice (no fluff, no preambles, declarative endings) but pointed at
your own data.

What you need:

- The required env from posture 1.
- Either: a Supabase project that matches the schemas in
  `DATA_CONTRACTS.md > Supabase: tables the bot READS`.
- Or: a forked `src/tools/` directory with your own data tools.
- Voyage if you want semantic recall over chat history.
- DuckDB shards if you want raw-query access to historical data; see
  `docs/DATA_SETUP.md > 5`.

What you change:

- Match the SQL schemas exactly (no source change), OR replace the tool
  files in `src/tools/` keeping the `{ spec, execute }` export shape.
- Optionally tweak the `[TOOLS_BLOCK]` in `src/prompt.js` so the model's
  mental map of "what's queryable" matches your tools.

What you keep:

- The voice. The `BEHAVIORAL_CONSTRAINTS` block was tuned for a
  technical, time-pressured audience; it works for most professional
  communities.

Use case: a quant fund's internal Slack-replacement, a hedge fund's
research chat, a market-making team's tactical assistant.

### 3. Different audience, different voice

The audience isn't a closed practitioner community — maybe it's a
customer support channel, an educational server, a hobbyist club.

What you need:

- Everything from posture 2.
- A rewritten `BEHAVIORAL_CONSTRAINTS` block in `src/prompt.js` that
  reflects your audience's needs (preambles might be fine; disclaimers
  might be required; specific compliance language might be mandatory).
- Updated assertions in `test/prompt.test.js` so the test suite
  enforces the new voice instead of the old one.

What you can't easily change without rethinking the architecture:

- The 8-round tool-use cap (in `agent.js MAX_TOOL_ROUNDS`).
- The pricing posture (per-turn cost audit + optional per-user daily
  cap). The structure assumes priced model calls.
- The streaming-progress-edit UX (debounced edits to keep under
  Discord's rate limit).

Use case: anyone who wants to fork the bot's engineering posture
(graceful shutdown, prompt-injection clamping, three-layer SQL guard,
JSON logging, audit log) without inheriting the trading-desk voice.

---

## Step-by-step fork checklist

1. **Fork the repo** on GitHub or clone locally.
2. **Pick a posture** (above).
3. **Update `package.json`** — change `name`, `description`. The
   `private: true` field stays unless you're publishing to npm.
4. **Set the operator identity** in `.env.local`:
   ```
   OPERATOR_HANDLE=<your handle>
   OPERATOR_NAME=<your real name>
   COMMUNITY_NAME=<your community name>
   ```
5. **Decide on the voice.** If you're keeping it (postures 1 + 2), no
   change. If you're rewriting (posture 3), edit
   `src/prompt.js BEHAVIORAL_CONSTRAINTS` and `test/prompt.test.js`'s
   assertions in the same commit.
6. **Wire the data layer** following `docs/DATA_SETUP.md`. The order:
   Discord → Anthropic → Voyage → Supabase → DuckDB. Skip anything you
   don't need.
7. **Update `OPERATOR_IDENTITY`'s real-name claim** if your prompt
   talks about specific people. The original block says "The operator
   who runs the server and authored this bot goes by ${handle}." If
   you're forking and a member asks who built the fork, the bot will
   credit the original `OPERATOR_NAME` env-var holder. Update the
   block in `src/prompt.js` if you want a different attribution.
8. **Re-author `README.md`** for your audience. The original opens
   with "A Discord bot for a private trading community"; that's
   probably wrong for your fork. Keep the architecture-oriented
   sections, replace the marketing copy.
9. **Update `LICENSE`** if needed. MIT is permissive; you can re-license
   any way the license allows, including keeping MIT and adding your
   copyright line.
10. **Run `npm run verify`** to confirm every configured external
    service is reachable.
11. **Run `npm run register`** to publish slash commands to Discord.
12. **Run `npm test`** to confirm the suite still passes. If you
    edited `BEHAVIORAL_CONSTRAINTS`, the test suite should fail until
    you update the assertions in `test/prompt.test.js`.
13. **Run `npm start`** and sanity-check `/ask`, `/about`, `/health`
    from a test guild.

---

## What stays the same regardless of fork

These pieces of the codebase are domain-agnostic and should not need
changes in any fork:

- `src/agent.js` — the tool-use loop, the retry wrapper, the audit
  persistence.
- `src/memory.js` — SQLite reads/writes, prepared statements, the
  schema migrations are in `src/db.js`.
- `src/embedder.js` — the background embed + sync loop.
- `src/lifecycle.js` — uncaught/unhandled handlers, drain semantics.
- `src/healthServer.js` — the HTTP probe.
- `src/logger.js` — JSON / pretty auto-detect.
- `src/backup.js` — `VACUUM INTO`.
- `src/rateLimiter.js`, `src/budget.js`, `src/toolCache.js` — domain-free
  capability layers.
- `src/progressReporter.js`, `src/textChunks.js` — Discord
  rendering helpers.

If you find yourself needing to edit these to make your fork work, open
an issue upstream — the abstraction might need extending, but the
modules themselves shouldn't need forking.

---

## When you're ready to share

If your fork is good, contribute back what's general:

- Bug fixes against the core layer.
- New tools that are domain-agnostic (e.g. a generic SQL backend, a
  generic news aggregator). Domain-specific tools should live in
  your fork, not upstream.
- Documentation improvements.
- Test additions that pin a contract the existing suite missed.

The upstream maintainer's bias is towards small, tight, well-justified
changes. See `CONTRIBUTING.md` for the workflow.
