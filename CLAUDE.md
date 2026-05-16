# Strategic Trading Discord Bot — Architecture Notes

A Discord bot that answers strategic options-trading questions, powered by
Claude Sonnet 4.6 with Anthropic tool-use over a Supabase market-data backend.

MIT-licensed and designed to be forked — the conversational surface is
generic, the data tools are pluggable.

## Stack

- Node.js 20+, ESM.
- `discord.js` v14 — long-running gateway connection.
- `@anthropic-ai/sdk` — message API with tool-use.
- Supabase via raw REST (no client lib needed — bot only reads).
- `node --env-file=.env.local` for env loading (no `dotenv` dependency).

## Two invocation surfaces

1. `/ask <question>` — slash command, registered via `scripts/register-commands.js`.
2. `@<bot> <question>` — mention in any channel. Requires the **MESSAGE
   CONTENT INTENT** gateway intent (and the matching Discord developer-portal
   privileged intent toggle) so the bot sees message text.

## Tool-use loop

`src/agent.js` runs the canonical Anthropic loop: model → if `stop_reason ===
'tool_use'`, execute the tools, append `{role: 'user', content:
tool_results}`, repeat. Capped at five rounds per turn so a buggy tool
can't run away with the conversation.

Tool modules in `src/tools/*.js` each export `{ spec, execute }`.
`tools/index.js` registers them and returns the spec list to the agent. The
specs are surfaced to Sonnet unmodified — tool selection is driven entirely
by the `description` field on each spec, so the descriptions are written to
be the source of truth.

## Data tools (default backend: aigamma.com Supabase)

Tables read:

- `vix_family_eod` (symbol, trading_date, close)
- `daily_volatility_stats` (trading_date, spx_close, hv_20d_yz, iv_30d_cm)
- `ingest_runs` (latest successful intraday SPX run — keys the rest of the
  intraday read path)
- `computed_levels` (call_wall_strike, put_wall_strike, volatility_flip, P/C)
- `expiration_metrics` (per-expiration atm_iv, put_25d_iv, call_25d_iv)

All queries mirror the exact shape `aigamma.com`'s Netlify functions use, so
schema drift is centrally addressable.

## Data licensing constraint

Inherited from aigamma's vendor agreement with Massive: the bot must not
republish raw contract-level data. Computed/derived metrics are fine. The
shipped tools respect this boundary by construction; do not modify them to
return per-strike IV grids, per-contract Greeks, or raw bid/ask.

## Secret management

- `.env.example` — documented template, no values, committed.
- `.env.local` — local secrets, `.gitignore`d.
- `src/config.js` — single point of env loading + validation. Fails fast at
  startup with a clear error if a required key is missing.
- Required: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`.
- Optional: `DISCORD_GUILD_ID` (for instant dev registration), `SUPABASE_URL`
  + `SUPABASE_KEY` (without them the tool surface is empty and the system
  prompt switches into "no live data" mode).

## Discord-specific notes

- The 2000-char message limit is handled by `chunk()` in `bot.js`. Paragraph
  → line → space → hard-cut fallback.
- Replies prefer `interaction.editReply` (after `deferReply`) and `followUp`
  for overflow. The bot does not stream — Discord doesn't natively support
  it and the edit-as-you-stream pattern adds complexity without much UX gain
  for short answers.
- `MESSAGE CONTENT INTENT` must be enabled both in code (it is) and in the
  Discord developer portal (manual setup step — see README).

## Forking for a different domain

Replace the four files in `src/tools/` with your own tool modules; update
`tools/index.js` to register them; tune `src/prompt.js` to the new domain.
The Discord wiring, agent loop, and env handling are domain-agnostic.

## Idle behavior

When working on this repo with no specific task, prioritize:

- Tightening tool descriptions (these directly drive model behavior).
- System prompt iteration — does it produce Discord-shaped replies, not
  blog-shaped ones?
- Adding tools that fill in coverage gaps (e.g. a per-stock IV tool if the
  Discord asks about single names; an event-calendar tool if pinpoint
  catalyst timing matters).
- Improving error surfacing — a tool that fails should produce a graceful
  in-channel reply, not a crash log on stderr.
