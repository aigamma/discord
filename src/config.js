// Loads + validates environment configuration once at startup. Fail fast with
// a clear message rather than letting a missing token surface as a cryptic
// discord.js login error or a 401 from Anthropic mid-conversation.

const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'ANTHROPIC_API_KEY'];

function safeInt(name, raw, fallback, { min = 0, max = Infinity } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    console.error(`[config] ${name}=${JSON.stringify(raw)} is not a valid integer in [${min}, ${max}]; using fallback ${fallback}`);
    return fallback;
  }
  return n;
}

function safeFloat(name, raw, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(`[config] ${name}=${JSON.stringify(raw)} is not a valid number in [${min}, ${max}]; using fallback ${fallback}`);
    return fallback;
  }
  return n;
}

function readEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
  if (missing.length > 0) {
    const lines = [
      'Missing required environment variables:',
      ...missing.map((k) => `  - ${k}`),
      '',
      'Copy .env.example to .env.local and fill in the values. See README.md.',
    ];
    throw new Error(lines.join('\n'));
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseKey = (process.env.SUPABASE_KEY || '').trim();
  const supabaseEnabled = Boolean(supabaseUrl && supabaseKey);

  const voyageKey = (process.env.VOYAGE_API_KEY || '').trim();
  const voyageEnabled = Boolean(voyageKey);

  return {
    discord: {
      token: process.env.DISCORD_BOT_TOKEN.trim(),
      clientId: process.env.DISCORD_CLIENT_ID.trim(),
      guildId: (process.env.DISCORD_GUILD_ID || '').trim() || null,
      ownerId: (process.env.OWNER_DISCORD_USER_ID || '').trim() || null,
    },
    operator: {
      // Identity surface for the system prompt's [OPERATOR IDENTITY] block.
      // Forkers can override these via env vars without editing source.
      handle: (process.env.OPERATOR_HANDLE || 'Blue').trim(),
      name: (process.env.OPERATOR_NAME || 'Eric Allione').trim(),
      communityName: (process.env.COMMUNITY_NAME || 'Options Alchemy').trim(),
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY.trim(),
      model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim(),
      maxTokens: safeInt('ANTHROPIC_MAX_TOKENS', process.env.ANTHROPIC_MAX_TOKENS, 4096, { min: 64, max: 200000 }),
      webSearchEnabled: (process.env.ENABLE_WEB_SEARCH || 'true').toLowerCase() !== 'false',
      webFetchEnabled: (process.env.ENABLE_WEB_FETCH || 'true').toLowerCase() !== 'false',
    },
    budget: {
      dailyUserCapUsd: safeFloat('DAILY_USER_COST_CAP_USD', process.env.DAILY_USER_COST_CAP_USD, 0, { min: 0 }),
    },
    supabase: {
      enabled: supabaseEnabled,
      url: supabaseUrl,
      key: supabaseKey,
    },
    voyage: {
      enabled: voyageEnabled,
      apiKey: voyageKey,
      model: (process.env.VOYAGE_MODEL || 'voyage-3').trim(),
    },
    memory: {
      dbPath: (process.env.CONVERSATION_DB_PATH || './data/conversation.db').trim(),
      shortTermTurns: safeInt('SHORT_TERM_CONTEXT_TURNS', process.env.SHORT_TERM_CONTEXT_TURNS, 12, { min: 0, max: 100 }),
      shortTermMinutes: safeInt('SHORT_TERM_CONTEXT_MINUTES', process.env.SHORT_TERM_CONTEXT_MINUTES, 60, { min: 1, max: 24 * 60 }),
      searchMinSimilarity: safeFloat('SEARCH_MIN_SIMILARITY', process.env.SEARCH_MIN_SIMILARITY, 0.15, { min: -1, max: 1 }),
    },
  };
}

export const config = readEnv();
