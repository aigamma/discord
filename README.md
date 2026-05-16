# Strategic Trading Discord Bot

An MIT-licensed Discord bot powered by **Claude Sonnet 4.6** that answers
strategic options-trading questions. Optionally connects to a Supabase market-data
backend (configured by default against the `aigamma.com` schema) so the model
can fetch live VIX-family readings, IV percentile rank, dealer-positioning
levels, and the SPX term structure on demand via Anthropic tool-use.

The bot is designed to be forkable: replace the data tools with your own and
the conversational surface stays the same.

## What it does

- **`/ask <question>`** — slash command. Explicit, scoped per channel/role.
- **`@bot <question>`** — mention the bot in any channel it can see.
- Sonnet 4.6 decides per-turn whether to call the live-data tools.

Tools shipped out of the box (against an aigamma-schema Supabase):

| Tool | What it returns |
|---|---|
| `get_vix_family_latest` | VIX, VVIX, term structure (VIX/VIX3M), cross-asset vol, SDEX/TDEX |
| `get_iv_percentile` | SPX 30d IV with percentile rank, 20d realized, variance risk premium |
| `get_gex_levels` | Current Vol Flip, Call Wall, Put Wall, P/C ratios |
| `get_spx_term_structure` | Per-expiration ATM IV, 25Δ put/call IV, skew |

If you don't configure Supabase, the bot still works — it answers from model
knowledge alone and explicitly declines questions that turn on a current number.

## Setup

### 1. Install

Requires Node.js 20+ and npm.

```bash
git clone <this-repo> trading-discord-bot
cd trading-discord-bot
npm install
```

### 2. Create the Discord bot

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Name it, click **Create**.
3. In the left sidebar, click **Bot**.
4. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**
   (required for `@mention` invocation). Save.
5. Click **Reset Token** and copy the token — this is your `DISCORD_BOT_TOKEN`.
6. Go back to **General Information** and copy the **Application ID** — this
   is your `DISCORD_CLIENT_ID`.

### 3. Invite the bot to your server

In the developer portal:

1. Open **OAuth2** → **URL Generator**.
2. Under **Scopes**, check `bot` and `applications.commands`.
3. Under **Bot Permissions**, check at minimum:
   `Send Messages`, `Read Message History`, `Use Slash Commands`,
   `Embed Links`. (Add `Mention @everyone` if you intend the bot to be
   pingable; not required.)
4. Copy the generated URL, open it in a browser, pick a server you own,
   and authorize.

### 4. Configure

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` — from step 2.
- `DISCORD_GUILD_ID` (optional) — right-click your server icon → **Copy Server
  ID** (requires Discord User Settings → **Advanced** → **Developer Mode**).
  If set, slash commands register to that guild only and propagate instantly.
  Leave blank for global registration (~1 hour propagation).
- `ANTHROPIC_API_KEY` — from <https://console.anthropic.com/settings/keys>.
- `SUPABASE_URL`, `SUPABASE_KEY` (optional) — see "Live data backend" below.

### 5. Register slash commands

```bash
npm run register
```

You only need to re-run this when you change the command surface.

### 6. Run

```bash
npm start
```

In Discord:

- `/ask is VVIX rich right now?`
- `@bot what does the SPX term structure say about front-month bid?`

Stop with `Ctrl+C`.

## Live data backend

The four shipped tools query a Supabase project laid out with the
`aigamma.com` schema. Specifically they read:

- `vix_family_eod` — symbol, trading_date, close
- `daily_volatility_stats` — trading_date, spx_close, hv_20d_yz, iv_30d_cm
- `ingest_runs` — latest healthy intraday SPX run
- `computed_levels` — call_wall_strike, put_wall_strike, volatility_flip, P/C ratios
- `expiration_metrics` — per-expiration atm_iv, put_25d_iv, call_25d_iv

If you're forking this bot for a different data source, the cleanest path is
to drop new tool modules in `src/tools/` and register them in
`src/tools/index.js`. Each tool exports `{ spec, execute }` where `spec` is
the Anthropic tool definition and `execute(input)` is the implementation.

**Use the anon (publishable) Supabase key, not a service key.** The bot only
reads, and RLS-gated anon access is the safe shape for a server-side process
running an open-source bot.

## Data licensing

If you're using the default aigamma backend, the bot follows aigamma's vendor
agreement with Massive: it surfaces only **computed** metrics (percentiles,
GEX outputs, term-structure points, regime labels) and never raw per-contract
chain data. The shipped tools are written to that boundary by construction;
do not modify them to return raw per-strike IV grids or raw bid/ask.

## Architecture

```
src/
  index.js          Entry point — validates env, logs in to Discord.
  config.js         Env loading + validation. Fails fast on missing required keys.
  bot.js            discord.js client + interaction routing (/ask + @mention).
  agent.js          Anthropic SDK tool-use loop. Capped at 5 rounds per turn.
  prompt.js         System prompt — the strategic-trading persona.
  supabase.js       Thin REST wrapper. The bot only reads.
  tools/            One file per tool. Each exports { spec, execute }.
    index.js        Tool registry + executor.
    vixFamily.js
    ivPercentile.js
    gexLevels.js
    termStructure.js
scripts/
  register-commands.js  One-off slash command registration.
```

## License

MIT. See `LICENSE`.
