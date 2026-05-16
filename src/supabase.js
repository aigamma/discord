// Minimal Supabase REST wrapper. The bot only reads, so a thin fetch helper
// is enough — no need to pull in @supabase/supabase-js. Mirrors the same
// PostgREST query shape that aigamma.com's Netlify functions use.

import { config } from './config.js';

const TIMEOUT_MS = 8000;

function authHeaders() {
  return {
    apikey: config.supabase.key,
    Authorization: `Bearer ${config.supabase.key}`,
    'Content-Type': 'application/json',
  };
}

export async function selectRows(path, params = {}) {
  if (!config.supabase.enabled) {
    throw new Error('Supabase is not configured — set SUPABASE_URL and SUPABASE_KEY in .env.local');
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${config.supabase.url}/rest/v1/${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}
