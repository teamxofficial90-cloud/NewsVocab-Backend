// Tests the marking step: words already in the history are wrapped in [ ] inside the full article text.
const assert = require("assert");
const { buildKnown, markKnownWords } = require("./mark");

const text = "The minister's speech was widely seen as conciliatory, yet critics called the policy \u201Cdraconian\u201D.\n\n" +
  "Reforms were stalled by an intransigent opposition. Draconian rules in 2026 stalls again; STALLING helps nobody.";
const unmark = (s) => s.replace(/[\[\]]/g, "");

// 1. exact words, any case, punctuation and curly quotes stay outside the brackets, original case is kept
let r = markKnownWords(text, buildKnown(["draconian", "Conciliatory"]));
assert.ok(r.text.includes("[conciliatory],") && r.text.includes("\u201C[draconian]\u201D.") && r.text.includes("[Draconian] rules"));
assert.strictEqual(r.known, 3);
assert.ok(r.text.includes("intransigent opposition") && !r.text.includes("[intransigent]"), "other words untouched");

// 2. the article is kept whole: take the brackets away and the text is identical, paragraph break included
assert.strictEqual(unmark(r.text), text);
assert.ok(r.text.includes(".\n\nReforms"));

// 3. inflected forms are marked too (same stem rule as validate.js): "stall" marks stalled / stalls / STALLING
r = markKnownWords(text, buildKnown(["stall"]));
assert.ok(r.text.includes("[stalled]") && r.text.includes("[stalls]") && r.text.includes("[STALLING]")); assert.strictEqual(r.known, 3);

// 4. empty history: the text comes back unchanged; empty text is fine
r = markKnownWords(text, buildKnown([]));
assert.strictEqual(r.text, text); assert.strictEqual(r.known, 0);
assert.deepStrictEqual(markKnownWords("", buildKnown(["x"])), { text: "", known: 0, fresh: 0 });

// 5. bad history entries are ignored; a substring of another word is not marked; numbers and symbols never are
r = markKnownWords("rule rules ruler 2026 - !!", buildKnown(["", null, "rul"]));
assert.strictEqual(r.text, "rule rules ruler 2026 - !!");

// 6. brackets that were already in the page cannot be confused with our marks
r = markKnownWords("He wrote [sic] and stalled.", buildKnown(["stalled"]));
assert.strictEqual(r.text, "He wrote (sic) and [stalled].");

// 7. it is linear: 200,000 words and a 10,000-word history in well under a second
const letters = (n) => [...n.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join("");
const words = Array.from({ length: 10000 }, (_, i) => "zz" + letters(i) + "qq");
const big = Array.from({ length: 200000 }, (_, i) => words[i % words.length] + (i % 5 ? "" : ",")).join(" ");
const t0 = Date.now(); r = markKnownWords(big, buildKnown(words.slice(0, 5000))); const ms = Date.now() - t0;
assert.ok(r.known > 0 && r.fresh > 0); assert.strictEqual(unmark(r.text), big); assert.ok(ms < 1000, "took " + ms + " ms");
console.log("mark tests passed (200k words marked in " + ms + " ms)");
