// Periodic postmortem report. Reads the audit log + feedback table and
// surfaces:
//
//   1. Total turns, cost, latency, p50/p95 over the window.
//   2. Recent thumbs-down reactions with the question and reply snippet.
//   3. Turns that errored (Anthropic upstream failures, tool errors).
//   4. Tool-call ranking with average latency.
//
// Run on demand:
//
//   node --env-file=.env.local scripts/postmortem.js [--hours 168]
//
// Output is plain text suitable for piping to a file or to the operator
// for an end-of-week review.

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const args = process.argv.slice(2);
let hours = 168;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hours') hours = parseInt(args[++i], 10);
}
const since = Date.now() - hours * 3600 * 1000;

const { db } = await import('../src/db.js');

function tableSection(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows || rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rows) console.log('  ' + r);
}

const total = db.prepare(`
  SELECT
    COUNT(*) AS turns,
    SUM(cost_usd) AS cost_usd,
    AVG(latency_ms) AS avg_latency,
    AVG(tool_rounds) AS avg_tool_rounds
  FROM turns WHERE created_at >= ?
`).get(since);

const latencyRows = db.prepare(`
  SELECT latency_ms FROM turns WHERE created_at >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC
`).all(since).map((r) => r.latency_ms);
const p50 = latencyRows[Math.floor(latencyRows.length * 0.5)] ?? null;
const p95 = latencyRows[Math.floor(latencyRows.length * 0.95)] ?? null;

console.log(`\nPostmortem report — last ${hours}h`);
console.log(`-----------------------------------`);
console.log(`Turns: ${total.turns}`);
console.log(`Total cost: $${(total.cost_usd || 0).toFixed(4)}`);
console.log(`Average latency: ${total.avg_latency ? Math.round(total.avg_latency) + 'ms' : 'n/a'}`);
console.log(`p50 / p95 latency: ${p50 ?? 'n/a'}ms / ${p95 ?? 'n/a'}ms`);
console.log(`Average tool rounds per turn: ${total.avg_tool_rounds ? total.avg_tool_rounds.toFixed(2) : 'n/a'}`);

const errors = db.prepare(`
  SELECT created_at, model, stop_reason, error, channel_id, user_id FROM turns
  WHERE created_at >= ? AND error IS NOT NULL
  ORDER BY created_at DESC LIMIT 25
`).all(since).map((r) => {
  const t = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
  return `${t} [${r.model}] ${r.user_id}: ${r.error.slice(0, 100)}`;
});
tableSection('Errors', errors);

let thumbsDown = [];
try {
  thumbsDown = db.prepare(`
    SELECT f.created_at, f.user_id, m.content AS reply, u.content AS question
    FROM feedback f
    LEFT JOIN messages m ON m.id = f.assistant_message_id
    LEFT JOIN turns t ON t.assistant_message_id = f.assistant_message_id
    LEFT JOIN messages u ON u.id = t.user_message_id
    WHERE f.created_at >= ? AND f.sentiment = 'down'
    ORDER BY f.created_at DESC LIMIT 20
  `).all(since).map((r) => {
    const t = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
    const q = (r.question || '(unknown question)').slice(0, 80).replace(/\n/g, ' ');
    const a = (r.reply || '(empty reply)').slice(0, 100).replace(/\n/g, ' ');
    return `${t} ${r.user_id} | Q: ${q} | A: ${a}`;
  });
} catch { /* table missing on a fresh DB; skip */ }
tableSection('Thumbs-down feedback', thumbsDown);

let toolStats = [];
try {
  toolStats = db.prepare(`
    SELECT j.value->>'name' AS tool, COUNT(*) AS calls, AVG(m.latency_ms) AS avg_latency_ms
    FROM messages m, json_each(m.tool_uses) j
    WHERE m.role = 'assistant' AND m.tool_uses IS NOT NULL AND m.created_at >= ?
    GROUP BY tool ORDER BY calls DESC LIMIT 15
  `).all(since).map((r) => {
    const lat = r.avg_latency_ms ? Math.round(r.avg_latency_ms) + 'ms' : 'n/a';
    return `${r.tool} — ${r.calls} calls, avg ${lat}`;
  });
} catch { /* json_each not available */ }
tableSection('Tool calls', toolStats);

console.log('\nReport complete.');
