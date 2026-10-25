// Helpers for the article cache (see server.js).
const crypto = require("crypto");

// The key of an article: a SHA-256 of its text with everything that is not a letter or digit collapsed to single spaces and
// lower-cased, so the same editorial scraped twice with different spacing, line breaks, quote marks or punctuation gets the same key.
// Only the hash is stored, never the article itself.
function articleHash(source) {
  const normalized = String(source).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// A small "recently seen" set (oldest entries drop out first). The server uses it to know which articles are very probably cached,
// without asking the database, when the Gemini line is full.
function createRecent(max = 2000) {
  const m = new Map();
  return {
    add(key) { m.delete(key); m.set(key, true); if (m.size > max) m.delete(m.keys().next().value); },
    has: (key) => m.has(key),
    clear: () => m.clear(),
    size: () => m.size
  };
}

// The cached words plus new ones found later by a per-user call. A new word is skipped if the article already has that word or another
// form of it (same stem). At most `max` words are kept. Returns { words, added }.
function mergeWords(existing, extra, stem, max = 60) {
  const stems = new Set(existing.map((w) => stem(w.word)));
  const words = existing.slice(); let added = 0;
  for (const w of extra) {
    if (words.length >= max) break;
    const s = stem(w.word);
    if (stems.has(s)) continue;
    stems.add(s); words.push(w); added++;
  }
  return { words, added };
}

module.exports = { articleHash, createRecent, mergeWords };
