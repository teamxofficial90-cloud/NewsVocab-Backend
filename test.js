const assert = require("assert");
const { selectWords, parseJsonLoose, stem, normalizeCandidates } = require("./validate");
const text = "The minister's speech was widely seen as conciliatory, yet critics called the policy draconian. " +
  "Delhi officials said a stringent audit would follow. Analysts warned the ambiguous wording could prove contentious. " +
  "Reforms were stalled by an intransigent opposition, and the ensuing gridlock exacerbated public anger. NATO observers were wary. " +
  "Several advocates argued that advocating restraint was prudent, and that the stalled talks would stall again.";
const mk = (word, extra = {}) => ({ word, partOfSpeech: "adjective", meaningInContext: "meaning here", simpleMeaning: "simple here", exampleSentence: "That was a " + word + " move.", ...extra });
const cands = [mk("draconian"), mk("Draconian"), mk("the"), mk("Delhi"), mk("NATO"), mk("notinarticle"), mk("stringent"),
  mk("ambiguous"), mk("contentious"), mk("intransigent"), mk("exacerbated"), mk("conciliatory"), mk("stalled"), mk("gridlock"), mk("ensuing", { excerpt: "the ensuing gridlock exacerbated public anger" }), mk("wary", { exampleSentence: "No usage." })];

// 1. plain selection, limit 10
let r = selectWords(cands, text, 10);
assert.strictEqual(r.words.length, 10);
assert.strictEqual(new Set(r.words.map((w) => w.word)).size, 10);
assert(!r.words.some((w) => ["the", "delhi", "nato", "notinarticle"].includes(w.word)));
assert.strictEqual(r.words.find((w) => w.word === "ensuing").excerpt, "the ensuing gridlock exacerbated public anger");
assert(r.rejected.some((x) => x.reason.startsWith("already learned or duplicate")));

// 2. different limits
assert.strictEqual(selectWords(cands, text, 3).words.length, 3);
assert.strictEqual(selectWords(cands, text, 20).words.length, 10); // only 10 valid exist: returns fewer, never invents

// 3. history: exact + inflected previous words are skipped
r = selectWords(cands, text, 5, ["draconian", "Stringent", "stall", "exacerbate"]);
const got = r.words.map((w) => w.word);
for (const bad of ["draconian", "stringent", "stalled", "exacerbated"]) assert(!got.includes(bad), bad + " should be skipped");
assert.strictEqual(got.length, 5);
assert(r.rejected.some((x) => x.word === "stalled"));

// 4. in-collection duplicates by stem: "advocates" vs "advocating"
const adv = [mk("advocates"), mk("advocating")];
assert.strictEqual(selectWords(adv, text, 5).words.length, 1);

// 5. stemmer
assert.strictEqual(stem("advocated"), stem("advocate"));
assert.strictEqual(stem("exacerbated"), stem("exacerbate"));
assert.strictEqual(stem("cities"), stem("city"));
assert.notStrictEqual(stem("ambiguous"), stem("draconian"));

assert.deepStrictEqual(parseJsonLoose('```json\n{"words":[1]}\n```'), { words: [1] });
// compact array rows from the model become the object form; objects, short rows and junk are handled
const rows = normalizeCandidates({ words: [["stringent", "adjective", "strict", "very strict", "A stringent rule."], mk("gridlock"), ["ensuing"], null, 7] });
assert.deepStrictEqual(rows[0], { word: "stringent", partOfSpeech: "adjective", meaningInContext: "strict", simpleMeaning: "very strict", exampleSentence: "A stringent rule." });
assert.strictEqual(rows[1].word, "gridlock"); assert.strictEqual(rows[2].word, "ensuing");
// synonyms and antonyms: the 7-item row keeps them; lists are cleaned (max 3, no duplicates, not the word itself, no junk);
// a missing or bad list never rejects the word
const rows7 = normalizeCandidates({ words: [["stringent", "adjective", "strict", "very strict", "A stringent rule.", ["Strict", "rigid", "rigid", "stringent", "tough", "harsh"], []]] });
assert.deepStrictEqual(rows7[0].synonyms.length, 6); assert.deepStrictEqual(rows7[0].antonyms, []);
const sel7 = selectWords([...rows7, mk("gridlock", { synonyms: "standstill, deadlock; impasse, stalemate", antonyms: ["flow", 42, "x".repeat(60), "<b>"] }), mk("ensuing")], text, 10);
assert.deepStrictEqual(sel7.words[0].synonyms, ["strict", "rigid", "tough"], "lower-cased, no duplicates, not the word itself, at most 3");
assert.deepStrictEqual(sel7.words[0].antonyms, [], "no antonym is fine");
assert.deepStrictEqual(sel7.words[1].synonyms, ["standstill", "deadlock", "impasse"], "a comma separated string is accepted");
assert.deepStrictEqual(sel7.words[1].antonyms, ["flow"], "numbers, very long items and markup are dropped");
assert.deepStrictEqual(sel7.words[2].synonyms, [], "a word with no lists is still accepted");
assert.deepStrictEqual(normalizeCandidates(null), []); assert.deepStrictEqual(normalizeCandidates({ words: "no" }), []);
r = selectWords(rows, text, 10);
assert.deepStrictEqual(r.words.map((w) => w.word), ["stringent", "gridlock"], "the incomplete row [ensuing] is rejected, junk is ignored");

console.log("validate tests passed");
