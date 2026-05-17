# Examples

What the bot actually does. Every example below shows a question and a
representative response of the shape the system prompt produces. The
numbers are real readings from the live Supabase backend at the time the
examples were written; the prose is illustrative.

## Live market reads

### Tactical: a single number

> `/ask question: what's the VVIX:VIX ratio right now?`

VVIX printed 92.94 against VIX at 18.43 on the latest end-of-day close, ratio 5.04. That sits in the upper third of the trailing twelve-month range; vol-of-vol is bid relative to spot vol, which usually says option premium is being demanded faster than the implied surface itself moves.

The model called `get_vix_family_latest` once, took the ratio off the
response, and produced four sentences.

### Strategic: regime question

> `@bot is short premium attractive right now?`

The variance risk premium is sitting at the 75th percentile of the trailing year (current IV30 at 14.5%, realized HV20 at 9.9%, spread +4.6 vol points). Short premium has historically been profitable through this regime; the tail risk is the 13.4% of days in the last year that printed negative VRP, which clusters during overnight gaps and into Fed weeks. The cleanest expression is a delta-neutral straddle short on a quarter-month tenor, not a wing structure, because the put skew at 25-delta is also at the high end of its sample and selling it doubles the gamma exposure.

The model chained two tools (`get_iv_percentile` then `get_vrp_history`)
and produced a directional view with structural reasoning. No
preambles, no "you should consider", no closing hooks.

### Cross-asset: where is the dispersion

> `/ask question: are sectors decoupling? show me the worst pair.`

Sector correlation over the trailing 60 days runs 0.31 on average. The worst-correlated pair is XLE-XLY at -0.64; energy is decoupling hard from discretionary. XLE-XLI at -0.47 and XLE-XLC at -0.55 confirm the pattern. The structural read is that energy is trading on its own oil narrative while the cyclical and growth complex is moving with rates and earnings; a pairs trade going long energy / short discretionary would size against that 41-day correlation and exit if average pairwise correlation snaps above 0.5.

Called `get_realized_correlations` once with the default sector ETF
basket. Identified the outlier and produced a trade idea.

### Dealer positioning

> `@bot where are we vs the vol flip?`

Spot SPX 7407, volatility flip 7411, so we sit one point below the flip and the regime is short-gamma. Call wall 7500 and put wall 7400 bracket the local range; dealers have to sell into rallies and buy into selloffs while we stay between those strikes. The put/call ratio at 1.56 on OI is meaningfully short-skewed, which is the typical state but worth flagging because below the flip the dealer hedge is the only structural buyer of vol.

`get_gex_levels` once; reported the numbers and the operational
consequence in three sentences.

## Memory recall

### Cross-day follow-up

> `@bot did we talk about the SPX put skew earlier this week?`

The bot calls `search_chat_history` with the user's exact query phrased
as a search. Returns the top hits from the channel's history, each with
a similarity score and a Discord jump-link. The model interprets:

Yes, on Tuesday Blue asked about the 25-delta put-skew at the 30-day tenor and the reply pointed at the 0.05 skew print versus a 0.03 trailing median; that came in response to the VIX backwardation flag fired in /vix earlier the same day. The skew has come in 80 bps since then while VVIX has held.

### Implicit follow-up

> `/ask question: how does that compare to today?`

The model has the short-term context window already loaded (the last
several turns of this channel in the last hour are prepended to every
call). It interprets "that" against the immediate prior thread without
needing the user to repeat what was discussed.

## Backtester / historical research

When the operator's aigamma-backtester has populated the DuckDB shards,
the bot picks them up and exposes `query_duckdb`. Sample question:

> `/ask question: how do short straddles on SPX perform when XLE is short-gamma and term structure is in backwardation?`

The model decomposes the question into a SQL filter:

```sql
WITH conditioning AS (
  SELECT date FROM derived.daily_regime
  WHERE xle_gamma_state = 'short' AND term_structure_inverted = 1
)
SELECT
  AVG(close - close * 0.97) / AVG(close * 0.97) AS avg_straddle_pl_pct,
  COUNT(*) AS sample_days
FROM index_history.index_history_eod
JOIN conditioning USING (date)
WHERE symbol = 'SPX';
```

(Schema is illustrative; the real query goes against the actual derived
table shapes once they're populated.) Tool returns rows; the model
narrates. The 1000-row cap, SELECT-only guard, and 30-second timeout
keep arbitrary queries safe.

## Tone discipline

What the bot **does not** do:

- It does not start with "Great question," "I'd be happy to help," or
  "Let me think about that."
- It does not say the user is "perceptive" or "thinking clearly."
- It does not close with "Would you like me to go deeper?" or "Let me
  know if you want a different angle."
- It does not use em-dashes, bullets in chat, emojis, or metaphors. No
  "the market is like a river" lines.
- It does not refuse to opine on direction. There is no compliance
  layer to satisfy; this is a closed community of practitioners.

What the bot **does** do:

- Lands the substance in the first sentence.
- Quotes specific numbers from tool calls, never invents.
- Names the structural reasoning behind every directional view.
- Ends with a declarative statement of fact or a direct answer.
- Stops when there's nothing more to say.

## When the bot declines

> `/ask question: give me the raw IV grid for SPX 28-Mar expiration`

The data backend's vendor terms prohibit redistributing per-contract chain data. The shipped tools return derived metrics by construction; the ATM IV, 25-delta put IV, and 25-delta call IV per expiration are available via get_spx_term_structure. The raw per-strike grid is not.

> `/ask question: what's NVDA going to do this week?`

NVDA opened the week at 198.50 and closed Friday at 225.32, up 13.6% over 30 days. The trend is strong but the price is at the 96th percentile of its 90-day range, which is the position from which mean reversion is most likely. Without a fresh catalyst the most asymmetric structure is a calendar-spread short the front week against a long the back, but I do not forecast point estimates of next week's close.

The model used `get_stock_history`, refused to point-forecast,
suggested a structural trade instead.
