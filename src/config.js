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

  return {
    discord: {
      token: process.env.DISCORD_BOT_TOKEN.trim(),
      clientId: process.env.DISCORD_CLIENT_ID.trim(),
      guildId: (process.env.DISCORD_GUILD_ID || '').trim() || null,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY.trim(),
      model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim(),
    },
    supabase: {
      enabled: supabaseEnabled,
      url: supabaseUrl,
      key: supabaseKey,
    },
  };
}

export const config = readEnv();
