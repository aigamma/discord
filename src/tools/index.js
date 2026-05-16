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
import * as searchChatHistory from './searchChatHistory.js';

const SUPABASE_MODULES = [vixFamily, ivPercentile, gexLevels, termStructure];
const MEMORY_MODULES = [searchChatHistory];

function activeModules() {
  const mods = [];
  if (config.supabase.enabled) mods.push(...SUPABASE_MODULES);
  if (config.voyage.enabled) mods.push(...MEMORY_MODULES);
  return mods;
}

export function getToolSpecs() {
  return activeModules().map((m) => m.spec);
}

const EXECUTORS = Object.fromEntries(
  [...SUPABASE_MODULES, ...MEMORY_MODULES].map((m) => [m.spec.name, m.execute])
);

export async function executeTool(name, input) {
  const fn = EXECUTORS[name];
  if (!fn) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await fn(input || {});
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
