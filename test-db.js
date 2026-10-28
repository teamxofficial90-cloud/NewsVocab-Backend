// Tests the trial / daily-quota / expiry / premium / history rules with a fake clock.
//   node test-db.js                      runs against the in-memory stand-in (no MongoDB needed)
//   MONGODB_URI=... node test-db.js      runs the SAME checks against a real MongoDB (uses a temporary
//                                        database that is deleted afterwards, your real data is not touched)
const assert = require("assert");
const { createDb } = require("./db");
const { pack, unpack } = require("./pack");

async function suite(collections) {
  let now = "2026-10-19";
  const db = createDb({ users: collections.users, histories: collections.histories, dictionary: collections.dictionary, counters: collections.counters, today: () => now });
  const email = "user@gmail.com";

  // signup: no free days (the Free plan from the start), the Rs. 1 trial not bought yet, quota 13, never used; plus an empty history document
  let u = await db.createUser("User@Gmail.com");
  assert.strictEqual(u.email, email); assert.strictEqual(u.expiry_date, "2026-10-19"); assert.strictEqual(u.trial_used, false);
  assert.strictEqual(u.daily_quota, 13); assert.strictEqual(u.last_used, null);
  assert.deepStrictEqual(await db.getHistory(u._id), []);
  assert.strictEqual((await db.createUser(email))._id.toString(), u._id.toString(), "signing up twice keeps the first account");
  let st = await db.status(u); assert.strictEqual(st.remainingToday, 13); assert.strictEqual(st.validUntil, "2026-10-18"); assert.strictEqual(st.active, false, "a new account starts on the Free plan"); assert.strictEqual(st.trialUsed, false); assert.strictEqual(st.freeWords, 3);

  // the paid trial: 3 days counting today (today + 2 is the last valid day), once per account
  u = await db.grantTrial(email); assert.strictEqual(u.expiry_date, "2026-10-22"); assert.strictEqual(u.trial_used, true);
  st = await db.status(u); assert.strictEqual(st.active, true); assert.strictEqual(st.validUntil, "2026-10-21"); assert.strictEqual(st.trialUsed, true);
  assert.strictEqual(await db.grantTrial(email), false, "the trial can be bought only once"); assert.strictEqual((await db.getUser(email)).expiry_date, "2026-10-22");
  assert.strictEqual(await db.grantTrial("nobody@gmail.com"), null);

  // first request today: 8 words -> 5 left, last_used today (saved before output)
  let r = await db.consume(email, 8); assert.ok(r.ok); assert.strictEqual(r.remaining, 5);
  u = await db.getUser(email); assert.strictEqual(u.daily_quota, 5); assert.strictEqual(u.last_used, "2026-10-19");
  // more than is left: refused, tells how many are left, nothing changes
  r = await db.consume(email, 6); assert.ok(!r.ok); assert.strictEqual(r.reason, "QUOTA"); assert.strictEqual(r.remaining, 5);
  assert.strictEqual((await db.getUser(email)).daily_quota, 5);
  // exactly what is left works, then zero left
  r = await db.consume(email, 5); assert.ok(r.ok); assert.strictEqual(r.remaining, 0);
  r = await db.consume(email, 1); assert.ok(!r.ok); assert.strictEqual(r.remaining, 0);
  // refund after a failed generation
  await db.refund(email, 5); assert.strictEqual((await db.getUser(email)).daily_quota, 5);
  await db.refund(email, 99); assert.strictEqual((await db.getUser(email)).daily_quota, 13, "refund never exceeds the daily 13");

  // next day: last_used is not today, so today starts again at 13
  now = "2026-10-20";
  assert.strictEqual((await db.status(await db.getUser(email))).remainingToday, 13);
  r = await db.consume(email, 13); assert.ok(r.ok); assert.strictEqual(r.remaining, 0);
  assert.strictEqual((await db.getUser(email)).last_used, "2026-10-20");

  // the last trial day (today + 2) still works
  now = "2026-10-21"; assert.ok((await db.consume(email, 1)).ok, "day 3 of the trial still works"); assert.ok(db.isActive(await db.getUser(email)));
  // the day after: expired = the Free plan
  now = "2026-10-22";
  r = await db.consume(email, 1); assert.ok(!r.ok); assert.strictEqual(r.reason, "EXPIRED");
  assert.strictEqual((await db.status(await db.getUser(email))).active, false); assert.ok(!db.isActive(await db.getUser(email)));
  // the Free plan may still use the daily quota when the caller allows it (the server caps it at 3 words)
  r = await db.consume(email, 3, { allowExpired: true }); assert.ok(r.ok); assert.strictEqual(r.remaining, 10);
  assert.strictEqual(db.constants.FREE_WORDS, 3);
  await db.refund(email, 3);

  // premium: 30 days counting today (today + 29 is the last valid day: valid 2026-10-22 .. 2026-11-20)
  u = await db.grantPremium(email); assert.strictEqual(u.expiry_date, "2026-11-21");
  assert.strictEqual((await db.status(u)).validUntil, "2026-11-20");
  assert.ok((await db.consume(email, 13)).ok, "usable again right after buying premium");
  now = "2026-11-20"; assert.ok((await db.consume(email, 1)).ok, "last premium day still works");
  now = "2026-11-21"; assert.strictEqual((await db.consume(email, 1)).reason, "EXPIRED");

  // bonus days (rewards) are saved and only used by the next premium plan
  now = "2026-12-01"; await db.addBonus(email, 5); await db.addBonus(email, 7); u = await db.getUser(email); assert.strictEqual(u.bonus_days, 12);
  assert.strictEqual(u.expiry_date, "2026-11-21", "bonus days do not change the plan"); assert.strictEqual((await db.status(u)).bonusDays, 12); assert.strictEqual(await db.addBonus("nobody@gmail.com", 1), null);
  u = await db.grantPremium(email); assert.strictEqual(u.expiry_date, "2027-01-12", "30 days + 12 bonus days from 2026-12-01"); assert.strictEqual(u.bonus_days, 0);
  u = await db.grantPremium(email); assert.strictEqual(u.expiry_date, "2027-01-12", "buying again never shortens a plan that runs longer (and the bonus is already used up)");
  assert.strictEqual(u.bonus_days, 0);
  await Promise.all([db.addBonus(email, 1), db.addBonus(email, 1), db.addBonus(email, 1)]); assert.strictEqual((await db.getUser(email)).bonus_days, 3, "simultaneous rewards all count");
  await db.grantPremium(email);

  // extendDays (rewards with "apply": "now"): an active plan grows from its end, an expired one restarts today
  now = "2027-03-01"; u = await db.grantPremium(email); const end = u.expiry_date;
  u = await db.extendDays(email, 3); assert.strictEqual(u.expiry_date, db.addDays(end, 3), "active plan: from its end");
  now = db.addDays(u.expiry_date, 5); u = await db.extendDays(email, 3); assert.strictEqual(u.expiry_date, db.addDays(now, 3), "expired plan: 3 days = today .. today + 2"); assert.strictEqual(await db.extendDays("nobody@gmail.com", 1), null);
  await Promise.all([db.extendDays(email, 1), db.extendDays(email, 1)]); assert.strictEqual((await db.getUser(email)).expiry_date, db.addDays(now, 5), "simultaneous extensions both count");

  // referral step (see rewards.js): a NEW account has ref_pending, a code can be claimed once, then the step is closed
  const ref1 = await db.createUser("ref1@gmail.com"), ref2 = await db.createUser("ref2@gmail.com"), ref3 = await db.createUser("ref3@gmail.com");
  assert.strictEqual(ref1.ref_pending, true, "a new account has the referral step open"); assert.strictEqual((await db.status(ref1)).refPending, true);
  assert.strictEqual((await db.createUser("ref1@gmail.com")).ref_pending, true, "signing in again does not reopen or close anything");
  assert.strictEqual(await db.claimReferral(ref2._id, ref1._id), true, "the new user claims the code of ref1");
  assert.strictEqual(await db.claimReferral(ref2._id, ref3._id), false, "a second claim by the same user is refused");
  u = await db.getUser("ref2@gmail.com"); assert.strictEqual(u.ref_pending, false); assert.strictEqual(String(u.referred_by), String(ref1._id)); assert.strictEqual((await db.status(u)).refPending, false);
  await db.reopenReferral(ref2._id); u = await db.getUser("ref2@gmail.com"); assert.strictEqual(u.ref_pending, true, "an undone claim opens the step again"); assert.ok(!u.referred_by);
  assert.strictEqual(await db.closeReferral(ref2._id), true, "skip closes the step"); assert.strictEqual(await db.closeReferral(ref2._id), false, "skipping twice changes nothing");
  assert.strictEqual(await db.claimReferral(ref2._id, ref1._id), false, "after a skip a code can never be used");
  assert.strictEqual(await db.claimReferral(u._id, ref1._id), false, "...not by a user whose step is closed");
  await collections.users.updateOne({ _id: ref3._id }, { $unset: { ref_pending: "" } }); // an account made before this feature existed
  assert.strictEqual(await db.claimReferral(ref3._id, ref1._id), false, "an old account (no ref_pending field) can never use a code"); assert.strictEqual((await db.status(await db.getUser("ref3@gmail.com"))).refPending, false);
  const race = await Promise.all([db.createUser("race@gmail.com")]).then(([x]) => Promise.all(Array.from({ length: 5 }, () => db.claimReferral(x._id, ref1._id))));
  assert.strictEqual(race.filter(Boolean).length, 1, "five simultaneous claims: exactly one wins");

  // unknown users, month/year rollover
  assert.strictEqual(await db.grantPremium("nobody@gmail.com"), null);
  assert.strictEqual((await db.consume("nobody@gmail.com", 1)).reason, "NO_ACCOUNT");
  assert.strictEqual(db.addDays("2026-12-31", 2), "2027-01-02");
  assert.strictEqual(db.addDays("2028-02-28", 2), "2028-03-01");

  // two requests at the same moment can never spend more than the quota
  const racer = (await db.createUser("racer@gmail.com")).email; now = "2026-11-10";
  const outcomes = await Promise.all([1, 2, 3, 4, 5, 6].map(() => db.consume(racer, 5)));
  assert.strictEqual(outcomes.filter((o) => o.ok).length, 2, "13 words = exactly two requests of 5");
  assert.strictEqual((await db.getUser(racer)).daily_quota, 3);

  // history: one document per user, a packed list of word numbers (3 bytes each), no duplicates, other users untouched
  u = await db.getUser(email);
  const ai = [
    { word: "Stringent", partOfSpeech: "adjective", meaningInContext: "strict and demanding", simpleMeaning: "very strict", exampleSentence: "A stringent rule." },
    { word: "gridlock", partOfSpeech: "noun", meaningInContext: "a deadlock in decisions", simpleMeaning: "a standstill", exampleSentence: "Gridlock again." }
  ];
  assert.strictEqual(await db.addHistory(u._id, ai), 2);
  assert.strictEqual(await db.addHistory(u._id, [ai[0], { word: "ephemeral", meaningInContext: "short-lived" }, "  Ephemeral "]), 1, "known words are skipped, plain strings work too");
  assert.deepStrictEqual(await db.getHistory(u._id), ["stringent", "gridlock", "ephemeral"]);
  const doc = await collections.histories.findOne({ user_id: u._id });
  assert.deepStrictEqual(unpack(doc.ids), [1, 2, 3], "words are numbered in the order they were first learned");
  assert.strictEqual(doc.ids.length, 9, "3 bytes per word");
  assert.deepStrictEqual(Object.keys(doc).filter((k) => k !== "_id").sort(), ["ids", "user_id", "ver", "word_count"], "no words, no meanings: numbers, their count and a version");
  assert.strictEqual(doc.word_count, 3); assert.strictEqual(doc.ver, 2, "one version step per save");
  assert.strictEqual(await db.addHistory(u._id, []), 0);
  assert.strictEqual((await db.status(u)).historyCount, 3);
  assert.deepStrictEqual(await db.getHistory((await db.getUser(racer))._id), []);
  // pack / unpack round trip, including the largest number
  assert.deepStrictEqual(unpack(pack([1, 255, 256, 65535, 65536, 600000, 16777215])), [1, 255, 256, 65535, 65536, 600000, 16777215]);
  assert.throws(() => pack([0])); assert.throws(() => pack([16777216]));
  assert.strictEqual(pack([1, 2, 3]).length, 9);

  // a history saved by the old version ({ word, meaning } entries) is still read, and converted when words are added
  const old = await db.createUser("old@gmail.com");
  await collections.histories.updateOne({ user_id: old._id }, { $set: { entries: [{ word: "legacy", meaning: "kept from before" }, { word: "former", meaning: "x" }] } });
  assert.deepStrictEqual(await db.getHistory(old._id), ["legacy", "former"]);
  assert.strictEqual(await db.addHistory(old._id, ["Fresh", "legacy"]), 1);
  const converted = await collections.histories.findOne({ user_id: old._id });
  assert.strictEqual(converted.entries, undefined, "meanings are dropped"); assert.strictEqual(converted.words, undefined);
  assert.strictEqual(converted.word_count, 3);
  assert.deepStrictEqual(await db.getHistory(old._id), ["legacy", "former", "fresh"]);

  // a history saved as TEXT (words: [..]) with details in the old string-keyed dictionary is converted to numbers, details kept, old documents removed
  const txt = await db.createUser("text@gmail.com");
  await collections.dictionary.insertMany([{ _id: "oldword", pos: "noun", m: "an old meaning", ex: "An oldword.", syn: ["x1", "x2"], ant: ["y1"] }]);
  await collections.histories.updateOne({ user_id: txt._id }, { $set: { words: ["oldword", "nodetails"], word_count: 2 }, $unset: { ids: "", ver: "" } });
  assert.deepStrictEqual(await db.getHistory(txt._id), ["oldword", "nodetails"], "text histories are read as they are");
  let h = await db.getHistoryDetails(txt._id);
  assert.strictEqual(h.entries[0].meaning, "an old meaning", "the old dictionary document still gives the details before conversion");
  assert.strictEqual(await db.addHistory(txt._id, ["brandnew"]), 1);
  const conv = await collections.histories.findOne({ user_id: txt._id });
  assert.strictEqual(conv.words, undefined); assert.strictEqual(unpack(conv.ids).length, 3); assert.strictEqual(conv.word_count, 3);
  assert.deepStrictEqual(await db.getHistory(txt._id), ["oldword", "nodetails", "brandnew"]);
  h = await db.getHistoryDetails(txt._id);
  assert.deepStrictEqual(h.words, ["oldword", "nodetails", "brandnew"]);
  assert.strictEqual(h.entries[0].meaning, "an old meaning"); assert.deepStrictEqual(h.entries[0].synonyms, ["x1", "x2"]); assert.strictEqual(h.entries[1].meaning, "");
  assert.ok(!collections.dictionary.docs.some((d) => typeof d._id === "string"), "old string-keyed dictionary documents are removed after conversion");

  // addHistory can reuse a history that was already read (one database read less) and gives the same result
  const state = await db.getHistoryState(u._id);
  assert.deepStrictEqual({ words: state.words, ids: state.ids, legacyWords: state.legacyWords, ver: state.ver }, { words: ["stringent", "gridlock", "ephemeral"], ids: [1, 2, 3], legacyWords: [], ver: 2 });
  const rd = collections.histories.findOne; let reads = 0; collections.histories.findOne = (...a) => { reads++; return rd.apply(collections.histories, a); };
  assert.strictEqual(await db.addHistory(u._id, ["cogent", "Gridlock"], state), 1);
  assert.strictEqual(reads, 0, "no extra read when the state is passed in");
  assert.strictEqual((await db.status(u)).historyCount, 4); assert.strictEqual(reads, 1, "status reads only the stored count");
  collections.histories.findOne = rd;

  // a history saved before word_count existed is counted once, and the count is stored
  await collections.histories.updateOne({ user_id: u._id }, { $unset: { word_count: "" } });
  assert.strictEqual((await db.status(u)).historyCount, 4);
  assert.strictEqual((await collections.histories.findOne({ user_id: u._id })).word_count, 4);

  // two requests adding words to the same history at the same moment: both are kept (compare-and-set, then retry)
  const twin = await db.createUser("twin@gmail.com");
  const results = await Promise.all([db.addHistory(twin._id, ["aaa1", "aaa2"]), db.addHistory(twin._id, ["bbb1", "bbb2"]), db.addHistory(twin._id, ["ccc1", "aaa1"])]);
  assert.strictEqual(results.reduce((a, b) => a + b, 0), 5, "five distinct words in total");
  assert.deepStrictEqual((await db.getHistory(twin._id)).sort(), ["aaa1", "aaa2", "bbb1", "bbb2", "ccc1"]);
  assert.strictEqual(new Set(unpack((await collections.histories.findOne({ user_id: twin._id })).ids)).size, 5, "no number twice");

  // two users learn the same NEW word at the same moment: one number, one dictionary document
  const t1 = await db.createUser("t1@gmail.com"), t2 = await db.createUser("t2@gmail.com");
  const before = collections.dictionary.docs.length;
  await Promise.all([db.addHistory(t1._id, [{ word: "contested", simpleMeaning: "from t1" }]), db.addHistory(t2._id, [{ word: "contested", simpleMeaning: "from t2" }])]);
  assert.strictEqual(collections.dictionary.docs.length, before + 1, "one dictionary document");
  const i1 = unpack((await collections.histories.findOne({ user_id: t1._id })).ids), i2 = unpack((await collections.histories.findOne({ user_id: t2._id })).ids);
  assert.deepStrictEqual(i1, i2, "both histories point to the same number");

  // ----- dictionary: one shared document per word, details stored once for all users -----
  const gen = (word, extra = {}) => ({ word, partOfSpeech: "adjective", meaningInContext: "only for this article", simpleMeaning: "plain meaning of " + word, exampleSentence: "A " + word + " example.", synonyms: ["s1", "s2"], antonyms: ["a1"], excerpt: "kept out", ...extra });
  const nDocs = collections.dictionary.docs.length;
  assert.strictEqual(await db.saveDictionary([gen("lucid"), gen("arduous"), gen("Lucid")]), 2, "two distinct words saved (a repeat inside one call counts once)");
  const lucid = collections.dictionary.docs.find((d) => d.w === "lucid");
  assert.deepStrictEqual(lucid, { _id: lucid._id, w: "lucid", pos: "adjective", m: "plain meaning of lucid", ex: "A lucid example.", syn: ["s1", "s2"], ant: ["a1"] }, "only the general details: no meaningInContext, no excerpt");
  assert.ok(Number.isInteger(lucid._id));
  // a second user learns the same word: the dictionary does not grow and the first saved meaning stays
  const second = await db.createUser("second@gmail.com");
  assert.strictEqual(await db.saveDictionary([gen("lucid", { simpleMeaning: "a DIFFERENT meaning" }), gen("cogent2")]), 1, "only the new word is added");
  assert.strictEqual(collections.dictionary.docs.length, nDocs + 3);
  assert.strictEqual(collections.dictionary.docs.find((d) => d.w === "lucid").m, "plain meaning of lucid", "the first meaning is kept");
  await db.addHistory(second._id, ["lucid", "cogent2"]);
  assert.strictEqual(unpack(collections.histories.docs.filter((x) => x.user_id === second._id)[0].ids).length, 2, "the user's history holds only numbers");
  // numbers are never reused or changed: a new word always gets a higher number
  const maxBefore = Math.max(...collections.dictionary.docs.map((d) => d._id));
  await db.saveDictionary([gen("freshest")]);
  assert.strictEqual(collections.dictionary.docs.find((d) => d.w === "freshest")._id, maxBefore + 1);
  // the history file: details for the user's words, in the user's order; a word with no dictionary entry has empty details
  const details = await db.getDetails(["cogent2", "lucid", "neverseen"]);
  assert.deepStrictEqual(details.map((d) => d.word), ["cogent2", "lucid", "neverseen"]);
  assert.strictEqual(details[1].meaning, "plain meaning of lucid"); assert.deepStrictEqual(details[1].synonyms, ["s1", "s2"]); assert.deepStrictEqual(details[1].antonyms, ["a1"]);
  assert.strictEqual(details[1].example, "A lucid example."); assert.strictEqual(details[1].partOfSpeech, "adjective");
  assert.deepStrictEqual(details[2], { word: "neverseen", partOfSpeech: "", meaning: "", synonyms: [], antonyms: [], example: "" });
  assert.deepStrictEqual(await db.getDetails([]), []);
  assert.strictEqual(await db.saveDictionary([]), 0);
  const full = await db.getHistoryDetails(second._id);
  assert.deepStrictEqual(full.words, ["lucid", "cogent2"]); assert.strictEqual(full.entries[0].meaning, "plain meaning of lucid"); assert.strictEqual(full.entries[1].example, "A cogent2 example.");

  // the number -> word cache: a second server (fresh cache) reads the same history, and a warm one needs no dictionary read
  const db2 = createDb({ users: collections.users, histories: collections.histories, dictionary: collections.dictionary, counters: collections.counters, today: () => now });
  assert.deepStrictEqual(await db2.getHistory(second._id), ["lucid", "cogent2"]);
  const fd = collections.dictionary.find; let dictReads = 0; collections.dictionary.find = (...a) => { dictReads++; return fd.apply(collections.dictionary, a); };
  assert.deepStrictEqual(await db2.getHistory(second._id), ["lucid", "cogent2"]); assert.strictEqual(dictReads, 0, "warm cache: no dictionary read");
  collections.dictionary.find = fd;

  // generation jobs: one request per user at a time, the result is kept for an hour, a dead request is replaced
  let clock = 1000000000000;
  const dj = createDb({ users: collections.users, histories: collections.histories, dictionary: collections.dictionary, counters: collections.counters, jobs: collections.jobs, today: () => now, now: () => clock });
  const ju = (await db.createUser("jobs@gmail.com"))._id;
  assert.deepStrictEqual(await dj.getJob(ju), { status: "none" });
  assert.deepStrictEqual(await dj.claimJob(ju, "job-1"), { ok: true });
  assert.deepStrictEqual(await dj.claimJob(ju, "job-2"), { ok: false, jobId: "job-1" }, "a second request is refused while the first runs");
  assert.strictEqual((await dj.getJob(ju)).status, "running");
  assert.strictEqual(await dj.ackJob(ju, "job-1"), false, "a running request is never removed by an acknowledgement");
  await dj.finishJob(ju, "job-1", { words: [{ word: "x" }], quota: { remainingToday: 3 } });
  let j = await dj.getJob(ju); assert.strictEqual(j.status, "done"); assert.strictEqual(j.result.words[0].word, "x");
  await dj.failJob(ju, "job-1", "late failure"); assert.strictEqual((await dj.getJob(ju)).status, "done", "an ended job cannot be changed again");
  clock += 59 * 60000; assert.strictEqual((await dj.getJob(ju)).status, "done", "still kept after 59 minutes");
  clock += 2 * 60000; assert.deepStrictEqual(await dj.getJob(ju), { status: "none" }, "gone after an hour");
  assert.deepStrictEqual(await dj.claimJob(ju, "job-3"), { ok: true }, "an old finished job is replaced");
  assert.strictEqual((await dj.getJob(ju)).jobId, "job-3"); assert.strictEqual((await dj.getJob(ju)).result, undefined, "nothing of the old result remains");
  clock += 6 * 60000; j = await dj.getJob(ju); assert.strictEqual(j.status, "failed", "running for more than 5 minutes: dead");
  assert.deepStrictEqual(await dj.claimJob(ju, "job-4"), { ok: true }, "a dead request does not block for ever");
  await dj.failJob(ju, "job-4", "boom"); assert.strictEqual((await dj.getJob(ju)).error, "boom");
  assert.strictEqual(await dj.ackJob(ju, "job-4"), true); assert.deepStrictEqual(await dj.getJob(ju), { status: "none" });
  await dj.claimJob(ju, "job-5"); await dj.dropJob(ju, "job-5"); assert.deepStrictEqual(await dj.getJob(ju), { status: "none" });
  const racers = await Promise.all([dj.claimJob(ju, "r-a"), dj.claimJob(ju, "r-b"), dj.claimJob(ju, "r-c")]);
  assert.strictEqual(racers.filter((x) => x.ok).length, 1, "of three requests at the same moment exactly one starts");

  // a big history: 20,000 words saved and read back, and the stored size is 3 bytes per word
  const bigUser = await db.createUser("big@gmail.com");
  const bigWords = Array.from({ length: 20000 }, (_, i) => "bw" + i.toString(36));
  const t0 = Date.now(); await db.addHistory(bigUser._id, bigWords); const saveMs = Date.now() - t0;
  const dbc = createDb({ users: collections.users, histories: collections.histories, dictionary: collections.dictionary, counters: collections.counters, today: () => now });
  const t1b = Date.now(); const back = await dbc.getHistory(bigUser._id); const coldMs = Date.now() - t1b;
  const t2b = Date.now(); await dbc.getHistory(bigUser._id); const warmMs = Date.now() - t2b;
  assert.deepStrictEqual(back, bigWords); assert.strictEqual((await collections.histories.findOne({ user_id: bigUser._id })).ids.length, 60000);
  console.log("  20,000-word history: save " + saveMs + " ms, cold read " + coldMs + " ms, warm read " + warmMs + " ms (in-memory stand-in; stored size 60,000 bytes)");
}

(async () => {
  const live = process.env.MONGODB_URI;
  const collections = live
    ? await require("./mongo").connect({ uri: live, dbName: "newsvocab_test_" + Date.now() })
    : require("./memory-db").createMemoryCollections();
  try { await suite(collections); console.log("db tests passed (" + (live ? "real MongoDB" : "in-memory") + ")"); }
  catch (e) { console.error("FAILED:", e.stack); process.exitCode = 1; }
  finally { await collections.drop(); await collections.close(); }
})();
