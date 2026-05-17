// Per-million-token USD pricing for each model the bot knows how to call,
// plus per-call pricing for server-side tools that Anthropic bills
// separately. Used to compute cost_usd on every turn for the audit log.
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Update when Anthropic publishes new prices.

const PRICING = {
  'claude-opus-4-7':    { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cache_write: 1.25, cache_read: 0.10 },
};

// Per-request pricing for Anthropic's server-side tools. web_search is
// billed at $10 per 1000 requests as of 2026; web_fetch is included in the
// token cost only. Source: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
const SERVER_TOOL_PRICING = {
  web_search_requests: 10 / 1000,
};

export function isModelPriced(model) {
  return Object.prototype.hasOwnProperty.call(PRICING, model);
}

export function priceUsage(model, usage) {
  const p = PRICING[model];
  if (!p || !usage) return null;
  const million = 1_000_000;
  const input = (usage.input_tokens || 0) * p.input / million;
  const output = (usage.output_tokens || 0) * p.output / million;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) * p.cache_write / million;
  const cacheRead = (usage.cache_read_input_tokens || 0) * p.cache_read / million;
  let serverTools = 0;
  if (usage.server_tool_use && typeof usage.server_tool_use === 'object') {
    for (const [key, count] of Object.entries(usage.server_tool_use)) {
      const rate = SERVER_TOOL_PRICING[key];
      if (rate && Number.isFinite(count)) serverTools += count * rate;
    }
  }
  return +(input + output + cacheWrite + cacheRead + serverTools).toFixed(6);
}
