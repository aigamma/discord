// Small pure-function helpers for the Discord bot. Kept here so they can
// be unit-tested without dragging the discord.js dependency graph into
// the test process.

export const MAX_DISCORD_MESSAGE = 2000;

// USD formatter for /usage, /admin feedback, and any other operator-
// facing surface. Handles null and non-finite (NaN, Infinity) inputs
// gracefully so a corrupted audit row doesn't leak '$NaN' into the UI.
export function formatUsd(n) {
  if (n == null || !Number.isFinite(n)) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(2)}`;
}

// Split a long string into Discord-message-sized chunks. Prefer breaks at
// blank lines, then single newlines, then spaces; fall back to a hard cut
// at MAX_DISCORD_MESSAGE if no break is available in the back half of the
// window. Used by bot.js for /ask, /summarize, and @mention replies that
// exceed Discord's 2000-character per-message ceiling.

export function chunk(text) {
  if (text.length <= MAX_DISCORD_MESSAGE) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_DISCORD_MESSAGE) {
    let cut = remaining.lastIndexOf('\n\n', MAX_DISCORD_MESSAGE);
    if (cut < 500) cut = remaining.lastIndexOf('\n', MAX_DISCORD_MESSAGE);
    if (cut < 500) cut = remaining.lastIndexOf(' ', MAX_DISCORD_MESSAGE);
    if (cut < 500) cut = MAX_DISCORD_MESSAGE;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
