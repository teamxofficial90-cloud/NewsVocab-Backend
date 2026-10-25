// Marks the words a learner already knows, inside the FULL article, before it is sent to Gemini.
//
//   history (array of words from MongoDB) --buildKnown--> Sets (built once per request, O(h))
//   page text --markKnownWords--> final text (one pass over the tokens, O(n), each lookup O(1))
//
// The final text starts as an empty string and every token of the page is appended in order. A token whose word
// is in the history is appended inside square brackets ("stalled," -> "[stalled],"); the prompt tells Gemini never to
// pick a bracketed word. Nothing is removed, so sentences and paragraphs stay intact.
const { stem } = require("./validate");

// Two lookup sets: the exact lower-case words, and their stems (so "stall" also marks "stalls" / "stalled",
// the same rule validate.js uses when it checks Gemini's answer).
function buildKnown(words) {
  const exact = new Set(); const stems = new Set();
  for (const w of words || []) {
    const lower = String(w || "").trim().toLowerCase();
    if (!lower) continue;
    exact.add(lower); stems.add(stem(lower));
  }
  return { exact, stems };
}

function isKnownWord(known, core) {
  const lower = core.toLowerCase();
  return known.exact.has(lower) || known.stems.has(stem(lower));
}

// Splits "\u201Cdraconian\u201D," into leading punctuation, the word, trailing punctuation.
const SPLIT_TOKEN = /^([^A-Za-z]*)([\s\S]*?)([^A-Za-z]*)$/;

// Returns { text, known, fresh }: the final text and how many tokens were marked / left unmarked.
function markKnownWords(text, known) {
  // [ and ] already in the page would be confused with our marks, so they become ( and ).
  const parts = String(text || "").replace(/\[/g, "(").replace(/\]/g, ")").split(/(\s+)/); // words and the whitespace between them
  let result = "";
  let marked = 0; let fresh = 0;
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { result += part; continue; } // spaces and line breaks are kept as they were
    const [, lead, core, trail] = part.match(SPLIT_TOKEN);
    if (core && isKnownWord(known, core)) { result += lead + "[" + core + "]" + trail; marked++; }
    else { result += part; fresh++; }
  }
  return { text: result, known: marked, fresh };
}

module.exports = { buildKnown, markKnownWords };
