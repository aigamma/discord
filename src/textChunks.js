// Split a long string into Discord-message-sized chunks. Prefer breaks at
// blank lines, then single newlines, then spaces; fall back to a hard cut
// at MAX_DISCORD_MESSAGE if no break is available in the back half of the
// window. Used by bot.js for /ask, /summarize, and @mention replies that
// exceed Discord's 2000-character per-message ceiling.

export const MAX_DISCORD_MESSAGE = 2000;

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
