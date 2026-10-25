// NewsVocab data layer (MongoDB). Collections (the premium payments are described further down, at "premium payments"; the article cache at "article cache"):
//   users       { _id, email, expiry_date, daily_quota, last_used }                  one document per user
//   histories   { _id, user_id -> users._id, ids: <packed bytes>, word_count, ver }  one document per user: the numbers of the
//                                                                                    learned words, 3 bytes each (see pack.js)
//   dictionary  { _id: 4711, w: "stringent", pos, m, ex, syn: [..], ant: [..] }      one document per word, SHARED by all users:
//                                                                                    _id is the word's permanent number, `w` the
//                                                                                    word (unique index), then the general details
//   counters    { _id: "dictionary", seq }                                           the last word number handed out
//   jobs        { user_id, job, status, started, expires_at, result?, error? }       one document per user: the latest generation request.
//                                                                                    status is "running", "done" (result = the answer sent
//                                                                                    to the popup) or "failed" (error). It exists so a user
//                                                                                    who closed the popup while waiting can still get the
//                                                                                    words; the popup acknowledges it, and MongoDB deletes
//                                                                                    it anyway one hour after the last change (TTL index)
// A word gets its number the first time anybody learns it, and the number never changes. The details of a word are stored once in
// `dictionary`; a user's history is only a packed list of numbers (3 bytes per word instead of ~20 for the text).
// The scan that wraps known words in [ ] needs the words themselves: numbers are turned back into words with an in-memory
// cache (number -> word) that is filled from `dictionary` only for numbers it has not seen yet, so a warm server needs no
// database read for it. Because numbers never change, the cache can never be stale, also with several servers.
// Dates are plain YYYY-MM-DD strings. The collections are MongoDB collections (see mongo.js);
// tests pass in-memory stand-ins (memory-db.js) that offer the same few methods.
//
// Rules
//  - Signup: last valid day = today + 4 (5 trial days), so expiry_date = today + 5; daily_quota = 13, last_used = empty,
//    ref_pending = true (the one chance to enter a friend's referral code, see rewards.js; ends when the code is used or skipped).
//  - Premium: last valid day = today + 20 (21 days), so expiry_date = today + 21, plus any saved bonus days (rewards, see rewards.js).
//  - The full plan ("Premium" in the popup, trial included) works on every date strictly before expiry_date. After that the account
//    is on the "Free" plan: it generates exactly like before (same 1-13 range, same daily quota of 13, all words saved to the
//    history), but the popup shows only the first FREE_WORDS (3) words, and the history download is refused (the popup also locks the DOCX).
//  - Each request: if last_used is today, daily_quota is what is left today; otherwise today starts at a fresh 13.
//    If the requested words fit, daily_quota is reduced and last_used set to today BEFORE anything is generated.
//  - Adding words to a history is read-change-write guarded by `ver` (compare-and-set): if another request changed the
//    history in between, it is re-read and the change is applied again, so nothing is lost.
//  - Older histories (`words: ["stringent", ...]` as text, or `entries: [{ word, meaning }]`) are still read, and are
//    converted to numbers the next time words are added (their details in the old string-keyed dictionary documents are kept).
const { pack, unpack, MAX_ID } = require("./pack");
// TRIAL_DAYS / PREMIUM_DAYS: the LAST valid day is today + N, so the plan covers N + 1 days counting today (4 -> 5 trial days, 20 -> 21 premium days).
// expiry_date (stored) is the first day the plan no longer works, i.e. today + N + 1.
const TRIAL_DAYS = 4, PREMIUM_DAYS = 20, DAILY_QUOTA = 13;
const FREE_WORDS = 3;   // a user whose plan has expired (the "Free" plan) is SHOWN only the first this-many words of a batch, and gets no downloads
const DUPLICATE_KEY = 11000;  // MongoDB error code for a unique-index clash
const RETRIES = 10;
const JOB_TTL_MS = 60 * 60 * 1000;    // a finished result is kept this long for a popup that was closed
const JOB_STALE_MS = 5 * 60 * 1000;   // a request still "running" after this long is treated as dead (for example the server restarted)

// Today's date (YYYY-MM-DD) in the given time zone. The "day" for quotas follows this zone.
const dateInZone = (tz, d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function createDb({ users, histories, dictionary, counters, jobs, articles, payments, rewards, timezone, today, now }) {
  const tz = timezone || "Asia/Kolkata";
  const todayFn = today || (() => dateInZone(tz)); // tests can pass a fake clock
  const nowMs = now || (() => Date.now());          // the same for the job timestamps
  const norm = (email) => String(email || "").trim().toLowerCase();
  const isDuplicate = (e) => e && e.code === DUPLICATE_KEY;
  const normWord = (w) => String(typeof w === "string" ? w : (w && w.word) || "").trim().toLowerCase();
  const CHUNK = 50000; // numbers per `$in` query (keeps every query far below MongoDB's 16 MB limit)
  const CACHE_MAX = 1500000;

  // number -> word. Filled on demand; numbers never change, so an entry is never wrong.
  let cache = new Map();
  const remember = (id, word) => { if (cache.size >= CACHE_MAX) cache = new Map(); cache.set(id, word); };
  const chunks = (list) => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };

  const getUser = (email) => users.findOne({ email: norm(email) });
  // One cheap read, used by /ping to prove the database answers (and to count as activity for an idle Atlas free cluster).
  const ping = () => counters.findOne({ _id: "__ping__" });

  async function ensureHistory(userId) {
    if (await histories.findOne({ user_id: userId })) return;
    try { await histories.insertOne({ user_id: userId, ids: Buffer.alloc(0), word_count: 0, ver: 0 }); }
    catch (e) { if (!isDuplicate(e)) throw e; } // another request created it first
  }

  async function createUser(email) {
    const e = norm(email);
    try {
      await users.insertOne({ email: e, expiry_date: addDays(todayFn(), TRIAL_DAYS + 1), daily_quota: DAILY_QUOTA, last_used: null, ref_pending: true });
    } catch (err) { if (!isDuplicate(err)) throw err; } // two sign-ins at once: keep the first
    const user = await getUser(e);
    await ensureHistory(user._id);
    return user;
  }

  // Gives an existing account PREMIUM_DAYS days counted from today, PLUS the bonus days it has saved up from rewards (they are
  // used up here: bonus_days goes back to 0 in the same write). Returns null if there is no such account.
  async function grantPremium(email) {
    for (let i = 0; i < RETRIES; i++) {
      const u = await getUser(email);
      if (!u) return null;
      const bonus = u.bonus_days || 0;
      const r = await users.updateOne({ _id: u._id, bonus_days: u.bonus_days === undefined ? null : u.bonus_days },
                                      { $set: { expiry_date: addDays(todayFn(), PREMIUM_DAYS + 1 + bonus), bonus_days: 0 } });
      if (r.matchedCount === 1) return getUser(email);
    }
    throw new Error("The account is busy. Please try again.");
  }

  // Adds `days` of full plan to the CURRENT plan (rewards with "apply": "now"): an active plan is extended from its end, an expired one
  // restarts today (days counted like the other plans: 3 days = today .. today + 2). Compare-and-set on expiry_date, so two rewards at the
  // same moment both count. Returns the updated user, or null if there is no such account.
  async function extendDays(email, days) {
    for (let i = 0; i < RETRIES; i++) {
      const u = await getUser(email);
      if (!u) return null;
      const t = todayFn();
      const r = await users.updateOne({ _id: u._id, expiry_date: u.expiry_date }, { $set: { expiry_date: addDays(t < u.expiry_date ? u.expiry_date : t, days) } });
      if (r.matchedCount === 1) return getUser(email);
    }
    throw new Error("The account is busy. Please try again.");
  }

  // Reward days with "apply": "next_premium" are NOT applied at once: they are saved on the account (`bonus_days`) and added to the next Premium plan (see grantPremium).
  // Compare-and-set, so two rewards at the same moment both count. Returns the updated user, or null if there is no such account.
  async function addBonus(email, days) {
    for (let i = 0; i < RETRIES; i++) {
      const u = await getUser(email);
      if (!u) return null;
      const r = await users.updateOne({ _id: u._id, bonus_days: u.bonus_days === undefined ? null : u.bonus_days }, { $set: { bonus_days: (u.bonus_days || 0) + days } });
      if (r.matchedCount === 1) return getUser(email);
    }
    throw new Error("The account is busy. Please try again.");
  }

  // ----- word numbers -----

  // The words for these numbers, in the same order (a number with no dictionary document is skipped). Cached numbers cost nothing;
  // the others are read from the dictionary (only the word field), in parallel chunks.
  async function wordsFor(ids) {
    const missing = [...new Set(ids.filter((id) => !cache.has(id)))];
    if (missing.length) {
      const found = await Promise.all(chunks(missing).map((c) => dictionary.find({ _id: { $in: c } }, { projection: { w: 1 } }).toArray()));
      for (const docs of found) for (const d of docs) if (typeof d.w === "string") remember(d._id, d.w);
    }
    const out = [];
    for (const id of ids) { const w = cache.get(id); if (w !== undefined) out.push(w); }
    return out;
  }

  // word -> number for the words that already have one (one indexed query on `w`).
  async function lookupIds(words) {
    const map = new Map();
    if (!words.length) return map;
    const found = await Promise.all(chunks(words).map((c) => dictionary.find({ w: { $in: c } }, { projection: { w: 1 } }).toArray()));
    for (const docs of found) for (const d of docs) { map.set(d.w, d._id); remember(d._id, d.w); }
    return map;
  }

  // Hands out `n` new numbers with ONE atomic counter update (so two requests can never get the same number).
  async function reserveIds(n) {
    const r = await counters.findOneAndUpdate({ _id: "dictionary" }, { $inc: { seq: n } }, { upsert: true, returnDocument: "after" });
    const doc = r && r.seq === undefined && r.value ? r.value : r; // older drivers wrap the document in { value }
    const last = doc.seq;
    if (last > MAX_ID) throw new Error("The word numbers are used up.");
    return Array.from({ length: n }, (_, i) => last - n + 1 + i);
  }

  // Makes sure every word has a number and a dictionary document. `entries` are words (strings) or validated words
  // { word, partOfSpeech, simpleMeaning, exampleSentence, synonyms, antonyms, ... }. A word already in the dictionary is
  // left untouched (the first saved meaning stays). `legacyWords` (optional Set) are words from an old-format history:
  // their details are taken over from the old string-keyed dictionary documents.
  // Returns { ids: Map(word -> number), inserted: how many new dictionary documents were created }.
  async function ensureWords(entries, legacyWords) {
    const byWord = new Map();
    for (const e of entries || []) { const w = normWord(e); if (w && !byWord.has(w)) byWord.set(w, e); }
    const ids = await lookupIds([...byWord.keys()]);
    const missing = [...byWord.keys()].filter((w) => !ids.has(w));
    if (!missing.length) return { ids, inserted: 0 };

    const old = new Map();
    const oldWanted = legacyWords ? missing.filter((w) => legacyWords.has(w)) : [];
    if (oldWanted.length) for (const d of await dictionary.find({ _id: { $in: oldWanted } }).toArray()) old.set(d._id, d);

    const nums = await reserveIds(missing.length);
    const docs = missing.map((w, i) => {
      const o = old.get(w); const e = byWord.get(w);
      if (o) return { _id: nums[i], w, pos: o.pos || "", m: o.m || "", ex: o.ex || "", syn: o.syn || [], ant: o.ant || [] };
      const x = e && typeof e === "object" ? e : {};
      return { _id: nums[i], w, pos: x.partOfSpeech || "", m: x.simpleMeaning || "", ex: x.exampleSentence || "",
               syn: Array.isArray(x.synonyms) ? x.synonyms : [], ant: Array.isArray(x.antonyms) ? x.antonyms : [] };
    });
    let inserted = docs.length; let clash = false;
    try { await dictionary.insertMany(docs, { ordered: false }); }
    catch (err) {
      const list = [].concat(err && err.writeErrors || []);
      const onlyDuplicates = err && (err.code === DUPLICATE_KEY || list.length > 0) && list.every((x) => (x.code !== undefined ? x.code : x.err && x.err.code) === DUPLICATE_KEY);
      if (!onlyDuplicates) throw err;
      inserted = docs.length - list.length; clash = true; // another request saved the same word first: its number wins
    }
    if (clash) for (const [w, id] of await lookupIds(missing)) ids.set(w, id);
    else docs.forEach((d) => { ids.set(d.w, d._id); remember(d._id, d.w); });
    return { ids, inserted };
  }

  // ----- history -----

  // The words saved by the old formats, if the document still has them (they are converted on the next save).
  const legacyOf = (doc) => {
    const set = new Set();
    if (doc && Array.isArray(doc.entries)) for (const e of doc.entries) if (e && e.word) set.add(e.word);
    if (doc && Array.isArray(doc.words)) for (const w of doc.words) if (typeof w === "string" && w) set.add(w);
    return [...set];
  };

  // One read of the history document: { words: [every word, oldest first], ids: [numbers], legacyWords, ver }.
  // addHistory can take this as its third argument, so the document is not read a second time.
  async function getHistoryState(userId) {
    const doc = await histories.findOne({ user_id: userId });
    const ids = doc && doc.ids ? unpack(doc.ids) : [];
    const legacyWords = legacyOf(doc);
    const fromIds = ids.length ? await wordsFor(ids) : [];
    return { words: [...new Set([...legacyWords, ...fromIds])], ids, legacyWords, ver: doc && doc.ver !== undefined ? doc.ver : null };
  }

  // The user's history as an array of lower-case words.
  async function getHistory(userId) {
    return (await getHistoryState(userId)).words;
  }

  // Adds the words (strings, or validated words with their details) to the user's history, and saves the details of words
  // that are new to the dictionary. Words already in the history are skipped. `state` is an optional result of getHistoryState
  // (skips the first read). Returns how many words were added.
  async function addHistory(userId, words, state) {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const s = (attempt === 0 && state) || await getHistoryState(userId);
      const known = new Set(s.words);
      const fresh = new Map();
      for (const w of words) { const word = normWord(w); if (word && !known.has(word) && !fresh.has(word)) fresh.set(word, w); }
      if (!fresh.size) return 0;
      const legacy = s.legacyWords.length > 0;
      const { ids } = await ensureWords([...s.legacyWords, ...fresh.values()], legacy ? new Set(s.legacyWords) : null);
      const have = new Set(s.ids); const combined = s.ids.slice(); let added = 0;
      for (const word of [...s.legacyWords, ...fresh.keys()]) {
        const id = ids.get(word);
        if (id === undefined || have.has(id)) continue;
        have.add(id); combined.push(id); if (fresh.has(word)) added++;
      }
      const update = { $set: { ids: pack(combined), word_count: combined.length, ver: (s.ver || 0) + 1 } };
      if (legacy) update.$unset = { words: "", entries: "" }; // converted: the text is dropped
      // Compare-and-set on `ver`: only succeeds if nobody changed the history since it was read.
      const r = await histories.updateOne({ user_id: userId, ver: s.ver }, update);
      if (r.matchedCount === 1) {
        if (legacy) dictionary.deleteMany({ _id: { $in: s.legacyWords } }).catch(() => {}); // old string-keyed documents are now copied
        return added;
      }
      if (!(await histories.findOne({ user_id: userId }))) await ensureHistory(userId);
    }
    throw new Error("The history is busy. Please try again.");
  }

  // ----- dictionary details -----

  const shape = (word, d) => ({ word, partOfSpeech: d ? d.pos || "" : "", meaning: d ? d.m || "" : "", synonyms: d && d.syn || [], antonyms: d && d.ant || [], example: d ? d.ex || "" : "" });

  // Saves the details of newly generated words (a word already there is left untouched). Returns how many were new.
  async function saveDictionary(entries) {
    return (await ensureWords(entries)).inserted;
  }

  // The details of the given words, one or two queries: [{ word, partOfSpeech, meaning, synonyms, antonyms, example }],
  // in the same order as `words`. A word without a dictionary document has empty details.
  async function getDetails(words) {
    const list = [...new Set((words || []).map(normWord).filter(Boolean))];
    const byWord = new Map();
    for (const docs of await Promise.all(chunks(list).map((c) => dictionary.find({ w: { $in: c } }).toArray()))) for (const d of docs) byWord.set(d.w, d);
    const rest = list.filter((w) => !byWord.has(w)); // not numbered yet: maybe still an old string-keyed document
    if (rest.length) for (const d of await dictionary.find({ _id: { $in: rest } }).toArray()) byWord.set(d._id, d);
    return list.map((word) => shape(word, byWord.get(word)));
  }

  // The user's whole history with details, for the history file: { words, entries } in the order the words were learned.
  async function getHistoryDetails(userId) {
    const doc = await histories.findOne({ user_id: userId });
    const ids = doc && doc.ids ? unpack(doc.ids) : [];
    const legacy = await getDetails(legacyOf(doc));
    const byId = new Map();
    for (const docs of await Promise.all(chunks([...new Set(ids)]).map((c) => dictionary.find({ _id: { $in: c } }).toArray()))) {
      for (const d of docs) { byId.set(d._id, d); if (typeof d.w === "string") remember(d._id, d.w); }
    }
    const entries = [...legacy]; const seen = new Set(legacy.map((e) => e.word));
    for (const id of ids) { const d = byId.get(id); if (d && typeof d.w === "string" && !seen.has(d.w)) { seen.add(d.w); entries.push(shape(d.w, d)); } }
    return { words: entries.map((e) => e.word), entries };
  }

  // true while the full plan (trial or premium) is running; false = the Free plan.
  const isActive = (user) => todayFn() < user.expiry_date;

  // What the popup shows: words left today, last valid day, and how many words are in the history.
  async function status(user) {
    const t = todayFn();
    // Reads only the stored count. Histories saved before the count existed are counted once and the count is saved.
    const h = await histories.findOne({ user_id: user._id }, { projection: { word_count: 1 } });
    let historyCount = h && Number.isInteger(h.word_count) ? h.word_count : null;
    if (historyCount === null) {
      historyCount = (await getHistory(user._id)).length;
      if (h) await histories.updateOne({ user_id: user._id }, { $set: { word_count: historyCount } }).catch(() => {});
    }
    return {
      dailyQuota: DAILY_QUOTA,
      freeWords: FREE_WORDS,
      remainingToday: user.last_used === t ? user.daily_quota : DAILY_QUOTA,
      expiryDate: user.expiry_date,
      validUntil: addDays(user.expiry_date, -1), // last day the account works
      bonusDays: user.bonus_days || 0,            // days earned with rewards, added to the next Premium plan
      refPending: user.ref_pending === true,      // a new account that has not used or skipped the referral-code step yet
      active: t < user.expiry_date,
      historyCount
    };
  }

  // Checks the account and reserves `words` from today's quota. The final write only succeeds if nobody else
  // changed the account in the meantime (compare-and-set), otherwise it re-reads and tries again.
  // `allowExpired`: the Free plan (expired account) may still use its daily quota. Returns { ok:true, remaining, ... } or { ok:false, reason: "NO_ACCOUNT"|"EXPIRED"|"QUOTA", ... }.
  async function consume(email, words, { allowExpired = false } = {}) {
    for (let i = 0; i < RETRIES; i++) {
      const t = todayFn();
      const u = await getUser(email);
      if (!u) return { ok: false, reason: "NO_ACCOUNT" };
      if (!allowExpired && !(t < u.expiry_date)) return { ok: false, reason: "EXPIRED", expiryDate: u.expiry_date };
      const available = u.last_used === t ? u.daily_quota : DAILY_QUOTA; // new day: starts again at 13
      if (words > available) return { ok: false, reason: "QUOTA", remaining: available };
      const r = await users.updateOne({ _id: u._id, daily_quota: u.daily_quota, last_used: u.last_used },
                                      { $set: { daily_quota: available - words, last_used: t } });
      if (r.matchedCount === 1) return { ok: true, remaining: available - words, expiryDate: u.expiry_date, validUntil: addDays(u.expiry_date, -1) };
    }
    throw new Error("The account is busy. Please try again.");
  }

  // Gives words back when generation failed after they were reserved (only if still the same day).
  async function refund(email, words) {
    for (let i = 0; i < RETRIES; i++) {
      const u = await getUser(email);
      if (!u || u.last_used !== todayFn()) return;
      const r = await users.updateOne({ _id: u._id, daily_quota: u.daily_quota, last_used: u.last_used },
                                      { $set: { daily_quota: Math.min(DAILY_QUOTA, u.daily_quota + words) } });
      if (r.matchedCount === 1) return;
    }
  }

  // ----- generation jobs (the result a closed popup can still pick up) -----

  // Starts the user's request. Only one request per user runs at a time: returns { ok:false, jobId } (the running one) if another is
  // still going, otherwise { ok:true }. The previous job document of this user (finished, failed or dead) is replaced.
  async function claimJob(userId, jobId) {
    for (let i = 0; i < RETRIES; i++) {
      const t = nowMs();
      const fresh = { user_id: userId, job: jobId, status: "running", started: new Date(t), expires_at: new Date(t + JOB_TTL_MS) };
      const cur = await jobs.findOne({ user_id: userId });
      if (!cur) {
        try { await jobs.insertOne(fresh); return { ok: true }; }
        catch (e) { if (!isDuplicate(e)) throw e; continue; } // another request created it first: look again
      }
      if (cur.status === "running" && t - new Date(cur.started).getTime() < JOB_STALE_MS) return { ok: false, jobId: cur.job };
      // Compare-and-set on the job we just read: a second request at the same moment cannot also win.
      const r = await jobs.replaceOne({ user_id: userId, job: cur.job, status: cur.status }, fresh);
      if (r.matchedCount === 1) return { ok: true };
    }
    throw new Error("The request is busy. Please try again.");
  }

  const endJob = (userId, jobId, fields) =>
    jobs.updateOne({ user_id: userId, job: jobId, status: "running" }, { $set: { ...fields, expires_at: new Date(nowMs() + JOB_TTL_MS) } });

  // The answer is ready: keep it for the popup (the same object that is sent as the HTTP reply).
  const finishJob = (userId, jobId, result) => endJob(userId, jobId, { status: "done", result });
  // Generation failed (the words were already refunded): keep the message so a closed popup can show it.
  const failJob = (userId, jobId, error) => endJob(userId, jobId, { status: "failed", error: String(error || "Generation failed.") });
  // Nothing worth keeping (for example the quota was refused): remove the job.
  const dropJob = (userId, jobId) => jobs.deleteOne({ user_id: userId, job: jobId });

  // The user's latest job as { status: "none"|"running"|"done"|"failed", jobId?, result?, error? }. An expired document counts as none
  // (MongoDB's TTL cleanup runs only about once a minute), and a job that has been "running" for too long counts as failed.
  async function getJob(userId) {
    const j = await jobs.findOne({ user_id: userId });
    const t = nowMs();
    if (!j || new Date(j.expires_at).getTime() <= t) return { status: "none" };
    if (j.status === "running" && t - new Date(j.started).getTime() >= JOB_STALE_MS) {
      return { status: "failed", jobId: j.job, error: "The request did not finish. Please generate again." };
    }
    return { status: j.status, jobId: j.job, result: j.result, error: j.error };
  }

  // The popup has the words now: forget them on the server. A request that is still running is never removed.
  async function ackJob(userId, jobId) {
    const j = await jobs.findOne({ user_id: userId });
    if (!j || j.job !== jobId || j.status === "running") return false;
    await jobs.deleteOne({ user_id: userId, job: jobId });
    return true;
  }

  // ----- article cache: the candidate words Gemini chose for an article, shared by everybody who reads it -----
  // One document per article: { h: hash of the text, words: [candidate entries, best first], created, expires_at } (MongoDB deletes it
  // after expires_at). It holds no user data. Without an `articles` collection the cache is simply off.

  // The cached words, or null when the article is not cached (an expired document counts as not cached: MongoDB's cleanup is slow).
  async function getArticle(hash) {
    if (!articles) return null;
    const a = await articles.findOne({ h: hash });
    return a && new Date(a.expires_at).getTime() > nowMs() && Array.isArray(a.words) && a.words.length ? a.words : null;
  }

  async function putArticle(hash, words, ttlMs) {
    if (!articles) return;
    const t = nowMs(); const doc = { h: hash, words, created: new Date(t), expires_at: new Date(t + ttlMs) };
    try { await articles.insertOne(doc); }
    catch (e) { // saved by another server a moment ago, or an expired leftover that MongoDB has not removed yet: replace the words
      if (!isDuplicate(e)) throw e;
      await articles.updateOne({ h: hash }, { $set: { words, created: doc.created, expires_at: doc.expires_at } });
    }
  }

  // Lets `change(words)` return a longer list (the extra words a per-user call found) and saves it. Last write wins: it is only a cache.
  async function updateArticleWords(hash, change) {
    if (!articles) return 0;
    const a = await articles.findOne({ h: hash });
    if (!a || !Array.isArray(a.words)) return 0;
    const { words, added } = change(a.words);
    if (added > 0) await articles.updateOne({ h: hash }, { $set: { words } });
    return added;
  }


  // ----- rewards (see rewards.js): free days for a review, a share, a referral ... -----
  // users get four optional fields: bonus_days (days earned, waiting for the next Premium plan), ref_code (their own referral code), referred_by (the _id of the user whose code they used, once) and ref_pending (true from sign-up until the user uses or skips the referral-code step).
  // rewards: { key (unique: "<user_id>:<reward id>" or "<referrer_id>:referral:<friend_id>"), user_id, email, reward, days, status: "pending" | "granted" | "rejected", created, decided? }
  const needRewards = () => { if (!rewards) throw new Error("The rewards collection is not available."); return rewards; };
  const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newRefCode = () => Array.from(require("crypto").randomBytes(8), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");

  // The user's own referral code (made on first use).
  async function getRefCode(user) {
    if (user.ref_code) return user.ref_code;
    for (let i = 0; i < 5; i++) {
      const code = newRefCode();
      if (await users.findOne({ ref_code: code })) continue;
      const r = await users.updateOne({ _id: user._id, ref_code: null }, { $set: { ref_code: code } });
      if (r.matchedCount === 1) return code;
      const fresh = await users.findOne({ _id: user._id }); // another request made it first
      if (fresh && fresh.ref_code) return fresh.ref_code;
    }
    throw new Error("Could not make a referral code.");
  }
  const findByRefCode = (code) => users.findOne({ ref_code: code });
  // A referral code can be used ONCE, right after sign-up, and only by an account that has not used or skipped the step yet
  // (`ref_pending: true`, set by createUser; older accounts have no such field, so they can never use a code).
  // Claiming is a compare-and-set: true only for the first call; it records who referred the user and closes the user's own chance.
  const claimReferral = async (userId, ownerId) => (await users.updateOne({ _id: userId, ref_pending: true }, { $set: { referred_by: ownerId, ref_pending: false } })).matchedCount === 1;
  // Undo a claim whose rewards could not be given (the user can try again).
  const reopenReferral = (userId) => users.updateOne({ _id: userId }, { $set: { referred_by: null, ref_pending: true } });
  // "Skip" (or the owner of a code that somebody just used: see rewards.js): the user can no longer enter a code. true if it was still open.
  const closeReferral = async (userId) => (await users.updateOne({ _id: userId, ref_pending: true }, { $set: { ref_pending: false } })).matchedCount === 1;

  // Records a reward; false if the same key exists already (so a reward counts once).
  async function insertReward(doc) {
    try { await needRewards().insertOne(doc); return true; }
    catch (e) { if (isDuplicate(e)) return false; throw e; }
  }
  const getReward = (key) => needRewards().findOne({ key });
  const deleteReward = (key) => needRewards().deleteOne({ key });
  const listRewards = (userId) => needRewards().find({ user_id: userId }).toArray();
  const listPendingRewards = () => needRewards().find({ status: "pending" }).toArray();
  // pending -> granted / rejected; true only for the one caller that wins.
  async function decideReward(key, status) {
    const r = await needRewards().updateOne({ key, status: "pending" }, { $set: { status, decided: new Date(nowMs()) } });
    return r.matchedCount === 1;
  }
  // granted -> pending again (the days could not be added, so the decision is undone).
  const undecideReward = (key) => needRewards().updateOne({ key }, { $set: { status: "pending" } });

  // ----- premium payments (see premium.js): one document per Razorpay payment link this server created -----
  // { pid: payment link id (unique), user_id, email, amount (paise), currency, status: "created" | "granted", url, created, expires_at, payment_id?, paid_at?, source? }
  // status "created" -> "granted" is a compare-and-set, so a payment extends the plan exactly once however many webhooks / checks arrive.
  const needPayments = () => { if (!payments) throw new Error("The payments collection is not available."); return payments; };

  const saveCheckout = (doc) => needPayments().insertOne(doc);
  async function getCheckout(pid) { return needPayments().findOne({ pid }); }
  // The user's links that are not used yet, newest first (at most `limit`).
  async function listCheckouts(userId, limit = 20) {
    const docs = await needPayments().find({ user_id: userId, status: "created" }).toArray();
    return docs.sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, limit);
  }
  // Marks a link as used. true only for the one caller that wins (compare-and-set on status).
  async function claimCheckout(pid, fields) {
    const r = await needPayments().updateOne({ pid, status: "created" }, { $set: { ...fields, status: "granted" } });
    return r.matchedCount === 1;
  }
  // Payment page mode: one document per captured payment (pid = the Razorpay payment id, unique), so a payment counts once.
  // Returns true if this call recorded it, false if that payment id was recorded before.
  async function recordPagePayment(doc) {
    try { await needPayments().insertOne(doc); return true; }
    catch (e) { if (isDuplicate(e)) return false; throw e; }
  }
  const releasePagePayment = (pid) => needPayments().deleteOne({ pid, kind: "page", status: "granted" });
  // Puts a claimed link back to "created" (the grant itself failed), so it can be settled again.
  const releaseCheckout = (pid) => needPayments().updateOne({ pid, status: "granted" }, { $set: { status: "created" } });

  return { ping, recordPagePayment, releasePagePayment, saveCheckout, getCheckout, listCheckouts, claimCheckout, releaseCheckout, getUser, createUser, claimJob, getArticle, putArticle, updateArticleWords, finishJob, failJob, dropJob, getJob, ackJob, grantPremium, getHistory, getHistoryState, getHistoryDetails, addHistory, saveDictionary, getDetails, status, isActive, consume, refund, extendDays, addBonus, getRefCode, findByRefCode, claimReferral, reopenReferral, closeReferral, insertReward, getReward, deleteReward, listRewards, listPendingRewards, decideReward, undecideReward,
           constants: { TRIAL_DAYS, PREMIUM_DAYS, DAILY_QUOTA, FREE_WORDS }, addDays };
}

module.exports = { createDb, TRIAL_DAYS, PREMIUM_DAYS, DAILY_QUOTA, FREE_WORDS, dateInZone, addDays };