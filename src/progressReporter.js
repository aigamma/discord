// Rate-limited progressive edit dispatcher. Streams partial assistant text
// into a Discord message, debounced to stay under Discord's ~5 edits/sec
// per-channel ceiling. The bot wraps each turn in one of these; agent.answer
// calls .update(text) as text accumulates, and .finalize(text) once at the
// end to land the canonical version (debounce skipped).
//
// Slash commands and @mentions share the same shape: pass a hook that
// performs the underlying edit. The reporter never throws — a failed
// Discord edit gets logged and the next tick retries.

import { logger } from './logger.js';

const MIN_EDIT_INTERVAL_MS = 800;
const MIN_DELTA_CHARS = 24;
const MAX_DISCORD_MESSAGE = 2000;
const CURSOR_GLYPH = ' ▌'; // ▌ thin block cursor

function truncateForEdit(text) {
  if (text.length <= MAX_DISCORD_MESSAGE - 2) return text + CURSOR_GLYPH;
  // Keep the head and a "(streaming...)" tail so the user can see where the
  // model is in the response. Long answers will be properly chunked at
  // finalize().
  return text.slice(0, MAX_DISCORD_MESSAGE - 20) + '… (streaming)';
}

export function createProgressReporter({ editText, label = 'edit' }) {
  let lastEditedLen = 0;
  let lastEditAt = 0;
  let pendingTimer = null;
  let lastText = '';
  let closed = false;

  async function doEdit(text, isFinal = false) {
    try {
      await editText(text);
      lastEditAt = Date.now();
      lastEditedLen = text.length;
    } catch (err) {
      logger.warn('progress edit failed', { label, err: err?.message || err, is_final: isFinal });
    }
  }

  async function flush() {
    if (closed) return;
    if (lastText.length - lastEditedLen < MIN_DELTA_CHARS) return;
    await doEdit(truncateForEdit(lastText));
  }

  function scheduleFlush() {
    if (pendingTimer) return;
    const wait = Math.max(MIN_EDIT_INTERVAL_MS - (Date.now() - lastEditAt), 0);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      flush();
    }, wait);
  }

  return {
    update(text) {
      if (closed) return;
      if (typeof text !== 'string') return;
      lastText = text;
      scheduleFlush();
    },
    note(text) {
      // Status update unrelated to streamed text (e.g. "calling tool X").
      // Bypasses the debounce because tool notes are rare.
      if (closed) return;
      doEdit(text);
    },
    async finalize(text) {
      closed = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      // No cursor glyph on the final edit; let the message land clean.
      const final = text || lastText;
      try {
        await editText(final.length > MAX_DISCORD_MESSAGE ? final.slice(0, MAX_DISCORD_MESSAGE) : final);
      } catch (err) {
        logger.warn('final edit failed', { label, err: err?.message || err });
      }
    },
  };
}
