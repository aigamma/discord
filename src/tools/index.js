// Tool registry. Each tool module exports `spec` (the Anthropic tool
// definition — name + description + JSONSchema) and `execute(input)` (the
// implementation that runs when the model picks it). The registry pairs them
// so the agent can look up an executor by name.
//
// Adding a tool: drop a new file in this directory exporting { spec, execute }
// and import + register it below. The system prompt does not need to be
// updated — Anthropic's tool-use surface drives discovery from the
// description field, so write descriptions clearly.

import { config } from '../config.js';
import * as vixFamily from './vixFamily.js';
import * as ivPercentile from './ivPercentile.js';
import * as gexLevels from './gexLevels.js';
import * as termStructure from './termStructure.js';
import * as stockHistory from './stockHistory.js';
import * as gexHistory from './gexHistory.js';
import * as realizedCorrelations from './realizedCorrelations.js';
import * as vrpHistory from './vrpHistory.js';
import * as searchChatHistory from './searchChatHistory.js';
import * as queryDuckdb from './queryDuckdb.js';
import { isReady as duckdbReady } from '../duckdb.js';

const SUPABASE_MODULES = [
  vixFamily,
  ivPercentile,
  gexLevels,
  termStructure,
  stockHistory,
  gexHistory,
  realizedCorrelations,
  vrpHistory,
];
const MEMORY_MODULES = [searchChatHistory];
const DUCKDB_MODULES = [queryDuckdb];

function activeModules() {
  const mods = [];
  if (config.supabase.enabled) mods.push(...SUPABASE_MODULES);
  if (config.voyage.enabled) mods.push(...MEMORY_MODULES);
  if (duckdbReady()) mods.push(...DUCKDB_MODULES);
  return mods;
}

export function getToolSpecs() {
  return activeModules().map((m) => m.spec);
}

const EXECUTORS = Object.fromEntries(
  [...SUPABASE_MODULES, ...MEMORY_MODULES, ...DUCKDB_MODULES].map((m) => [m.spec.name, m.execute])
);

// Per-tool cache TTL overrides. Tools not listed inherit the default 60s.
// Live-data surfaces stay short; historical / cross-section surfaces can
// hold for longer because the underlying tables refresh daily.
const TOOL_TTLS = {
  get_gex_levels: 30,
  get_spx_term_structure: 30,
  get_vix_family_latest: 300,
  get_iv_percentile: 300,
  get_stock_history: 600,
  get_gex_history: 600,
  get_realized_correlations: 600,
  get_vrp_history: 600,
  search_chat_history: 30,
  query_duckdb: 60,
};

import * as toolCache from '../toolCache.js';

export async function executeTool(name, input) {
  const fn = EXECUTORS[name];
  if (!fn) {
    return { error: `Unknown tool: ${name}` };
  }
  const ttl = TOOL_TTLS[name] ?? 60;
  if (ttl > 0) {
    const cached = toolCache.get(name, input);
    if (cached !== null) return cached;
  }
  try {
    const result = await fn(input || {});
    // Defense: a tool that forgets to return drops `content` from the
    // Anthropic tool_result block (JSON.stringify(undefined) is
    // undefined, and the missing key trips a 400 from the API). Coerce
    // null/undefined into a structured no-result error.
    if (result === undefined || result === null) {
      return { error: `Tool ${name} returned no result.` };
    }
    if (ttl > 0 && !result?.error) {
      toolCache.set(name, input, result, ttl);
    }
    return result;
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

export function getToolCacheStats() {
  return toolCache.stats();
}
