// Validation of AI output. Never trust the model blindly.
const STOPWORDS = new Set(("the a an and or but if then than that this these those is are was were be been being have has had having do does did " +
  "good bad very much many more most some any each every other another such only own same just also about above after again against all " +
  "because before below between both down during from further here into itself more once only over through under until very what when where which while who whom why with would could should " +
  "said says say make made take took get got go went come came know knew think thought see saw want use used thing things people time year years").split(/\s+/));

const FIELDS = ["partOfSpeech", "meaningInContext", "simpleMeaning", "exampleSentence"];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function normalizeWhitespace(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

/** Light stemmer so "advocate", "advocates" and "advocated" count as the same word. */
function stem(word) {
  let w = String(word).toLowerCase().replace(/[\u2019']/g, "");
  if (w.length <= 4) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  const strip = (suffix) => { if (w.endsWith(suffix) && w.length - suffix.length >= 4) { w = w.slice(0, -suffix.length); return true; } return false; };
  if (!(strip("ing") || strip("ed") || strip("es") || strip("ly") || (!w.endsWith("ss") && strip("s")))) { /* no suffix */ }
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const MAX_LIST = 3;       // at most 3 synonyms / 3 antonyms are kept
const MAX_LIST_ITEM = 30; // a longer item is not a word or a short phrase

/** Turns the model's synonym/antonym field (array, or "a, b, c") into up to 3 clean lower-case strings. */
function cleanList(value, selfWord) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : [];
  const out = [];
  for (const it of items) {
    const v = normalizeWhitespace(it).toLowerCase();
    if (!v || v.length > MAX_LIST_ITEM || v === selfWord || out.includes(v)) continue;
    if (!/^[a-z][a-z' -]*$/.test(v)) continue;
    out.push(v);
    if (out.length === MAX_LIST) break;
  }
  return out;
}

/** Returns { entry } or { reason }. */
function validateEntry(raw, articleText, opts = {}) {
  if (!raw || typeof raw !== "object") return { reason: "not an object" };
  const word = normalizeWhitespace(raw.word);
  if (!/^[A-Za-z][A-Za-z'\u2019-]{3,}$/.test(word)) return { reason: "not a single alphabetic word: " + word };
  const lower = word.toLowerCase();
  if (STOPWORDS.has(lower)) return { reason: "common word: " + word };
  if (word === word.toUpperCase()) return { reason: "abbreviation: " + word };

  // Must appear in the article, and at least once in lower case (filters proper names).
  const re = new RegExp("(?<![A-Za-z])" + escapeRe(word) + "(?![A-Za-z])", "gi");
  const hits = articleText.match(re) || [];
  if (hits.length === 0) return { reason: "not in article: " + word };
  if (!hits.some((h) => h[0] === h[0].toLowerCase())) return { reason: "looks like a proper name: " + word };

  const entry = { word: lower };
  for (const f of FIELDS) {
    const v = normalizeWhitespace(raw[f]);
    if (v.length < 3) return { reason: "missing " + f + " for " + word };
    entry[f] = v;
  }
  if (!new RegExp("(?<![A-Za-z])" + escapeRe(word.slice(0, Math.max(4, word.length - 3))), "i").test(entry.exampleSentence)) {
    return { reason: "example sentence does not use the word: " + word };
  }
  // Synonyms and antonyms are optional (some words have no antonym): a bad list never rejects the word.
  entry.synonyms = cleanList(raw.synonyms, lower);
  entry.antonyms = cleanList(raw.antonyms, lower);
  // Optional excerpt: keep only if it really is in the article.
  const ex = normalizeWhitespace(raw.excerpt);
  const flat = normalizeWhitespace(articleText);
  if (ex && ex.length <= 300 && flat.toLowerCase().includes(ex.toLowerCase())) entry.excerpt = ex;
  return { entry };
}

/**
 * Take candidates in order; keep valid, distinct ones that are NOT in `previousWords`
 * (exact match or same stem), up to `limit`.
 * `rejected` is a list of { word, reason }.
 */
function selectWords(candidates, articleText, limit = 10, previousWords = [], opts = {}) {
  const seenStems = new Set();
  for (const p of previousWords) if (typeof p === "string" && p.trim()) seenStems.add(stem(p.trim()));
  const out = []; const rejected = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const { entry, reason } = validateEntry(c, articleText, opts);
    if (!entry) { rejected.push({ word: c && typeof c.word === "string" ? c.word.trim().toLowerCase() : "", reason }); continue; }
    const s = stem(entry.word);
    if (seenStems.has(s)) { rejected.push({ word: entry.word, reason: "already learned or duplicate: " + entry.word }); continue; }
    seenStems.add(s); out.push(entry);
    if (out.length === limit) break;
  }
  return { words: out, rejected };
}

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// The prompt asks for compact rows: ["word", "partOfSpeech", "meaningInContext", "simpleMeaning", "exampleSentence", [synonyms], [antonyms]]
// (shorter output = faster answer). Rows become the object form the rest of the code uses; objects are still accepted.
function normalizeCandidates(parsed) {
  const list = parsed && Array.isArray(parsed.words) ? parsed.words : [];
  return list.map((w) => {
    if (!Array.isArray(w)) return w;
    const [word, partOfSpeech, meaningInContext, simpleMeaning, exampleSentence, synonyms, antonyms] = w;
    const row = { word, partOfSpeech, meaningInContext, simpleMeaning, exampleSentence };
    if (synonyms !== undefined) row.synonyms = synonyms;
    if (antonyms !== undefined) row.antonyms = antonyms;
    return row;
  });
}

module.exports = { validateEntry, selectWords, parseJsonLoose, stem, normalizeCandidates };
