// Thin CLI wrapper around runBackup(). Calls the shared backup primitive
// so the slash-command path and the CLI path produce byte-identical
// output and rotation behavior.

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { runBackup } = await import('../src/backup.js');

const args = process.argv.slice(2);
let outPath = null;
let keep = parseInt(process.env.BACKUP_KEEP || '14', 10);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--out') outPath = args[++i];
  else if (args[i] === '--keep') keep = parseInt(args[++i], 10);
}

const result = runBackup({ outPath, keep });
console.log(JSON.stringify({
  level: 'info',
  msg: 'backup complete',
  out_path: result.outPath,
  bytes: result.bytes,
  mb: result.mb,
  elapsed_ms: result.elapsedMs,
}));
for (const r of result.rotated) {
  console.log(JSON.stringify({ level: 'info', msg: 'backup rotated out', removed: r }));
}
