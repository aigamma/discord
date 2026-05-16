// Loads + validates environment configuration once at startup. Fail fast with
// a clear message rather than letting a missing token surface as a cryptic
// discord.js login error or a 401 from Anthropic mid-conversation.

const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'ANTHROPIC_API_KEY'];

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
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY.trim(),
      model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim(),
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096', 10),
      webSearchEnabled: (process.env.ENABLE_WEB_SEARCH || 'true').toLowerCase() !== 'false',
      webFetchEnabled: (process.env.ENABLE_WEB_FETCH || 'true').toLowerCase() !== 'false',
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
      shortTermTurns: parseInt(process.env.SHORT_TERM_CONTEXT_TURNS || '12', 10),
      shortTermMinutes: parseInt(process.env.SHORT_TERM_CONTEXT_MINUTES || '60', 10),
      searchMinSimilarity: parseFloat(process.env.SEARCH_MIN_SIMILARITY || '0.15'),
    },
  };
}

export const config = readEnv();
