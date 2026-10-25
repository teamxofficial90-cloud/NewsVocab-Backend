// NewsVocab backend: keeps the Gemini API key on the server, never in the extension.
// Needs the \"mongodb\" npm package (cd backend && npm install). Start with:  GEMINI_API_KEY=... node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { selectWords, parseJsonLoose, normalizeCandidates, stem } = require("./validate");
const { createAuth } = require("./auth");
const { createDb } = require("./db");
const { buildKnown, markKnownWords } = require("./mark");
const { articleHash, createRecent, mergeWords } = require("./article-key");
const { createGate } = require("./gate");
const { createPremium } = require("./premium");
const { createRewards } = require("./rewards");

// Minimal .env loader (optional)
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) { /* no .env file */ }

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // use 0.0.0.0 when deploying (e.g. Render)

// Sessions are signed with SESSION_SECRET. Without one, a random secret is used and everyone is
// logged out whenever the server restarts.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString("hex"); }
// Accounts, plan expiry, daily quota and word history live in MongoDB (see db.js). Both are created in start().
let db, auth, gate, premium, rewards; // premium (Razorpay purchase, see premium.js) is created in start() too; gate (the Gemini queue, see gate.js) is created in start() too
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // protects POST /admin/premium; endpoint is off when empty
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_ARTICLE_CHARS = 10000; // about 1,600 words; longer articles are cut here (a shorter text is also a faster Gemini call)
const MAX_BODY_BYTES = 400 * 1024;
const MIN_LIMIT = 1, MAX_LIMIT = 13;
// Gemini traffic control (see gate.js): at most GEMINI_CONCURRENCY calls run at once, QUEUE_SIZE more wait in line, the rest are turned away.
const envInt = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };
const QUEUE_FULL_MESSAGE = "Sorry, try again";
const GEMINI_TIMEOUT_MS = envInt("GEMINI_TIMEOUT_MS", 45000);       // one Gemini call that takes longer than this is cancelled
const GEMINI_MAX_RETRIES = envInt("GEMINI_MAX_RETRIES", 2);          // extra tries after a 429/500/503 from Gemini
const GEMINI_RETRY_BASE_MS = envInt("GEMINI_RETRY_BASE_MS", 1500);   // waits 1.5 s, then 3 s (doubling) before the retries
const MIN_FRESH_WORDS = 50;      // if fewer unmarked (not yet learned) words than this are in the article, there is nothing new to teach

// Optional speed setting: limits the model's "thinking" before it answers (a word list needs none). The value is a JSON object whose
// fields depend on the model family, e.g. GEMINI_THINKING_CONFIG={"thinkingBudget":0} or {"thinkingLevel":"low"}. Not set by default.
let THINKING = null;
if (process.env.GEMINI_THINKING_CONFIG) {
  try { THINKING = JSON.parse(process.env.GEMINI_THINKING_CONFIG); }
  catch (e) { console.error("GEMINI_THINKING_CONFIG is not valid JSON, so it is ignored."); }
}

const SYSTEM = `You are an expert English vocabulary teacher who reads newspaper articles and editorials.
Return ONLY a JSON object, with no commentary and no markdown fences.`;

function buildPrompt({ title, text, limit, candidateCount }) {
  return `From the article below, choose ${candidateCount} candidate vocabulary words, best first. The learner needs ${limit} final words, so a few extra candidates are a safety margin.

Choose words that are:
- important in journalism and editorials, advanced but practical, useful for comprehension, interviews, competitive exams and professional communication;
- used in the article in a sense that its context makes clear.

Never choose: common words (the, is, have, good), names of people/places/organizations, dates, numbers, abbreviations, or words picked just because they are long. No duplicates. Each "word" must be ONE word, copied exactly as spelled in the article, in lower case.

IMPORTANT: in the article text, every word the learner has already studied is wrapped in square brackets, like [stalled]. Never choose a bracketed word or any other form of it. You may still use bracketed words to understand the context. The brackets are not part of the article: never put them in any field of your answer.

For each word give ONE array of exactly 7 items, in this order, keeping every text short:
1. the word
2. its part of speech (as used in the article)
3. what it means in THIS article (max 15 words)
4. the general, plain-English meaning of the word, as a dictionary would give it, that a learner can understand (max 12 words)
5. an ORIGINAL example sentence (max 18 words, not copied from the article) using the same meaning and the same word
6. an array of 2 or 3 common synonyms (single words, lower case)
7. an array of 1 to 3 common antonyms (single words, lower case); use [] only if the word truly has no antonym

Output format: {"words":[["word","partOfSpeech","meaningInContext","simpleMeaning","exampleSentence",["synonym1","synonym2"],["antonym1"]],...]}

ARTICLE TITLE: ${title}

ARTICLE TEXT:
${text}`;
}

async function callModel(prompt, model = MODEL) {
  const url = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com") + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  let res;
  try {
    res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 8192, ...(THINKING ? { thinkingConfig: THINKING } : {}) }
    })
    });
  } catch (e) {
    if (e && e.name === "TimeoutError") { const err = new Error("Gemini took too long to answer."); err.status = 504; throw err; }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "HTTP " + res.status;
    const err = new Error(msg); err.status = res.status;
    // Gemini reports an invalid key as HTTP 400 (API_KEY_INVALID) rather than 401.
    if (res.status === 400 && /API key|API_KEY/i.test(msg)) err.status = 401;
    throw err;
  }
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned no text" + (cand && cand.finishReason ? " (" + cand.finishReason + ")" : "") + ".");
  return text;
}

// callModel, plus a short wait and another try when Gemini says it is busy (429/500/503). The caller still holds its place in the
// gate meanwhile, so retries cannot pile extra load on top of the limit.
async function callModelWithRetry(prompt, model) {
  for (let attempt = 0; ; attempt++) {
    try { return await callModel(prompt, model); }
    catch (e) {
      const busy = e.status === 429 || e.status === 500 || e.status === 503;
      if (!busy || attempt >= GEMINI_MAX_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, GEMINI_RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

// `history` is the array of words the learner already knows. In the final text sent to Gemini, the article (cut at
// MAX_ARTICLE_CHARS) is kept and every history word is wrapped in [ ]. The same cut text is used to validate Gemini's answer.
// ONE Gemini call only: if fewer than `limit` valid new words come back, the caller gets just those (never a second call).
async function generateVocabulary({ title, text, limit, history, model }) {
  const source = text.slice(0, MAX_ARTICLE_CHARS);
  const marked = markKnownWords(source, buildKnown(history)); // one O(n) pass, O(1) Set lookups
  if (marked.fresh < MIN_FRESH_WORDS) {
    const err = new Error("Almost nothing new is left in this article: nearly every word in it is already in your history. Try a different article.");
    err.friendly = true; throw err;
  }
  const candidateCount = Math.min(limit + 3, 30); // a few extra, because candidates that fail validation are skipped (less output = faster)
  const raw = await callModelWithRetry(buildPrompt({ title, text: marked.text, limit, candidateCount }), model);
  const parsed = parseJsonLoose(raw);
  const candidates = normalizeCandidates(parsed);
  // Also rejects any history word (exact or same stem) the model returns anyway.
  const { words } = selectWords(candidates, source, limit, history);
  if (words.length === 0) {
    const err = new Error(history.length > 0
      ? "No new words could be found in this article that are not already in your history. Try a different article."
      : "No suitable vocabulary words could be found in this article. Try a different article.");
    err.friendly = true; throw err;
  }
  return { words, candidates }; // `candidates` (everything the model returned) is only used by scripts/benchmark-models.js
}

function send(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*", // extension popup origin is chrome-extension://<id>
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, GET, OPTIONS"
  });
  res.end(JSON.stringify(obj));
}

// Reads and parses a JSON body; answers the request itself and returns undefined on failure.
function readJson(req, res) {
  return new Promise((resolve) => {
    let size = 0; let tooBig = false; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY_BYTES) tooBig = true; else chunks.push(c); });
    req.on("end", () => {
      if (tooBig) { send(res, 413, { error: "Request too large." }); return resolve(); }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}); }
      catch (e) { send(res, 400, { error: "Invalid JSON body." }); resolve(); }
    });
  });
}

// Reads the body as raw bytes (the Razorpay webhook signature is calculated over exactly these bytes); answers the request itself and returns undefined on failure.
function readRaw(req, res) {
  return new Promise((resolve) => {
    let size = 0; let tooBig = false; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY_BYTES) tooBig = true; else chunks.push(c); });
    req.on("end", () => { if (tooBig) { send(res, 413, { error: "Request too large." }); return resolve(); } resolve(Buffer.concat(chunks)); });
    req.on("error", () => resolve());
  });
}

// The account as the popup sees it (db.status plus the referral step). The step after sign-up ("Do you have a referral code?") is offered
// only while the developer has the referral switched on in rewards.json; `refDays` and `refApply` are what the popup tells the new user they will get.
async function accountStatus(user) {
  const s = await db.status(user);
  const ref = rewards.config().referral;
  if (s.refPending && ref.enabled) { s.refDays = ref.days; s.refOwnerDays = ref.ownerDays; s.refApply = ref.apply; } else s.refPending = false;
  return s;
}

// One button for everyone: if the verified Gmail is already in the database the user is logged in,
// otherwise an account (5-day trial) is created for it.
async function handleGoogleAuth(req, res) {
  const body = await readJson(req, res); if (!body) return;
  try {
    const profile = await auth.verifyGoogleIdToken(body.idToken);
    let user = await db.getUser(profile.email);
    const isNewUser = !user;
    if (isNewUser) user = await db.createUser(profile.email);
    send(res, 200, { token: auth.issueSession(user), user: auth.publicUser(user), isNewUser, account: await accountStatus(user) });
  } catch (e) {
    console.error("[auth]", e.message);
    send(res, e.status || 500, { error: e.status ? e.message : "Sign-in failed because of a server error. Try again." });
  }
}

// Manual grant (support, refunds, tests): the user gets 21 days (today + 20) from today. Normal purchases go through Razorpay instead (see premium.js).
// Checks the x-admin-key header; answers the request itself and returns false when it is not allowed.
function adminOk(req, res) {
  const given = String(req.headers["x-admin-key"] || "");
  const ok = ADMIN_KEY && given.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_KEY));
  if (!ok) send(res, ADMIN_KEY ? 401 : 404, { error: ADMIN_KEY ? "Wrong admin key." : "Not found" });
  return !!ok;
}

async function handleGrantPremium(req, res) {
  if (!adminOk(req, res)) return;
  const body = await readJson(req, res); if (!body) return;
  const user = typeof body.email === "string" ? await db.grantPremium(body.email) : null;
  if (!user) return send(res, 404, { error: "No account with that email. The user must sign in once first." });
  send(res, 200, { email: user.email, account: await accountStatus(user) });
}

// ----- Earn free days (rewards.js; the developer switches it on and off in rewards.json) -----
const rewardError = (res, e, what) => { console.error("[" + what + "]", e.message); send(res, e.status || 500, { error: e.friendly ? e.message : "Something went wrong. Please try again.", ...(e.code ? { code: e.code } : {}) }); };
async function accountOf(user) { return accountStatus((await db.getUser(user.email)) || user); }
async function handleRewardsList(res, user) {
  try { send(res, 200, await rewards.list(user)); } catch (e) { rewardError(res, e, "rewards"); }
}
async function handleRewardClaim(req, res, user) {
  const body = await readJson(req, res); if (!body) return;
  try { const r = await rewards.claim(user, String(body.id || ""), body.proof); send(res, 200, { ...r, account: await accountOf(user) }); } catch (e) { rewardError(res, e, "reward claim"); }
}
async function handleRewardRedeem(req, res, user) {
  const body = await readJson(req, res); if (!body) return;
  try { const r = await rewards.redeem(user, body.code); send(res, 200, { ...r, account: await accountOf(user) }); } catch (e) { rewardError(res, e, "referral"); }
}
// The "Skip" button of the referral step right after sign-up: the new user will not enter a code (and cannot later). Safe to press twice.
async function handleReferralSkip(res, user) {
  try { await rewards.skipReferral(user); send(res, 200, { ok: true, account: await accountOf(user) }); } catch (e) { rewardError(res, e, "referral skip"); }
}
// Developer: GET /admin/rewards/pending lists claims waiting for a decision; POST /admin/rewards/decide { email, reward, approve } approves or rejects one.
async function handleAdminRewards(req, res) {
  if (!adminOk(req, res)) return;
  if (req.method === "GET") return send(res, 200, { pending: await rewards.pending() });
  const body = await readJson(req, res); if (!body) return;
  if (typeof body.email !== "string" || typeof body.reward !== "string" || typeof body.approve !== "boolean") return send(res, 400, { error: "Send { email, reward, approve: true | false }." });
  const r = await rewards.decide(body.email, body.reward, body.approve);
  send(res, r.ok ? 200 : r.reason === "ALREADY_DECIDED" ? 409 : 404, r);
}

// ----- Premium purchase (Razorpay; the logic is in premium.js) -----
// Razorpay calls this when a payment link has been paid. No login: the HMAC signature (RAZORPAY_WEBHOOK_SECRET) is the proof.
async function handleRazorpayWebhook(req, res) {
  const raw = await readRaw(req, res); if (!raw) return;
  try {
    const r = await premium.handleWebhook(raw, req.headers["x-razorpay-signature"]);
    send(res, r.status, r.body);
  } catch (e) {
    console.error("[razorpay webhook]", e.message);
    send(res, 500, { error: "Could not process the webhook." }); // Razorpay retries a webhook that did not get a 2xx answer
  }
}

// The popup's Get Premium button: creates a Rs. 9.00 Razorpay payment page for this user and returns its address.
async function handleCheckout(res, user) {
  try { const r = await premium.createCheckout(user); send(res, 200, { url: r.url, ...(r.pageMode ? { pageMode: true, email: user.email } : {}) }); }
  catch (e) { console.error("[checkout]", e.message); send(res, e.status || 500, { error: e.friendly ? e.message : "Could not start the payment. Please try again." }); }
}

// The popup asks whether the user's payment has gone through (it opens with an expired plan, or the user presses "I have paid").
async function handleVerifyPayment(res, user) {
  try {
    const r = await premium.verifyForUser(user);
    const fresh = (await db.getUser(user.email)) || user;
    send(res, 200, { granted: !!r.granted, throttled: !!r.throttled, ...(r.pageMode ? { pageMode: true, email: user.email } : {}), account: await accountStatus(fresh) });
  } catch (e) { console.error("[verify payment]", e.message); send(res, e.status || 500, { error: e.friendly ? e.message : "Could not check the payment. Please try again." }); }
}

// The popup can be closed while Gemini is still working (Chrome closes it on any click elsewhere). The server keeps going anyway,
// so every request is recorded as a "job" (see db.js): whatever happens, the outcome is saved for an hour and the popup can ask for it
// the next time it opens (GET /api/vocab/last), then confirm it has the words (POST /api/vocab/ack).
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Does the work of one request and returns { status, body }. The job document says "running" while this runs, and ends as "done"
// (the words), "failed" (the message) or removed (nothing worth keeping).
// ----- Article cache -----
// The first user to read an article makes ONE Gemini call that picks CACHE_CANDIDATES words for the article itself (nothing about any
// user goes into it). Everybody after that gets the first words from that list that are not in their own history: no Gemini call, an
// instant answer. If a user's history leaves too few, that one user gets a normal per-user call (generateVocabulary), and any new words
// it finds are added to the list. ARTICLE_CACHE=off turns all of this off.
const CACHE_CANDIDATES = 30;   // words asked from Gemini for a new article
const CACHE_MAX_WORDS = 60;    // most words kept per article, after per-user calls have added some
let cacheOn = false, cacheTtlMs = 0;
let hotArticles = createRecent(2000);          // hashes cached or being fetched on this server: lets a cached article through a full line
const pendingArticles = new Map();             // hash -> { promise, leaderKey } while the first request for an article is at Gemini
const followerOf = new Map();                  // queue key of a request waiting for another request's Gemini call -> that request's queue key
const cacheStats = { hits: 0, waited: 0, misses: 0, fallbacks: 0 }; // shown by /health
const cacheLikely = (hash) => pendingArticles.has(hash) || hotArticles.has(hash);
const friendlyError = (message) => { const e = new Error(message); e.friendly = true; return e; };
const noWordsMessage = (history) => history.length > 0
  ? "No new words could be found in this article that are not already in your history. Try a different article."
  : "No suitable vocabulary words could be found in this article. Try a different article.";

// The one Gemini call for a new article: the whole article (nothing marked), CACHE_CANDIDATES words, checked like any other answer.
async function fetchCandidates({ title, source }) {
  const raw = await callModelWithRetry(buildPrompt({ title, text: source, limit: MAX_LIMIT, candidateCount: CACHE_CANDIDATES }));
  const { words } = selectWords(normalizeCandidates(parseJsonLoose(raw)), source, CACHE_CANDIDATES, []);
  if (words.length === 0) throw friendlyError(noWordsMessage([]));
  return words;
}

// The article's candidate words: from the database (hit), from the request that is already asking Gemini (waited), or by asking Gemini
// now (leader). Concurrent requests for the same new article therefore cost one Gemini call, not one each.
async function articleWords({ hash, title, source, key }) {
  let pending = pendingArticles.get(hash);
  if (!pending) {
    const cached = await db.getArticle(hash);
    if (cached) { cacheStats.hits++; hotArticles.add(hash); return { role: "hit", entries: cached }; }
    pending = pendingArticles.get(hash); // a request may have started asking Gemini while we asked the database
  }
  if (pending) {
    cacheStats.waited++;
    followerOf.set(key, pending.leaderKey); // so the popup of a waiting request can still show a countdown
    try { return { role: "waited", entries: await pending.promise }; } finally { followerOf.delete(key); }
  }
  cacheStats.misses++;
  const promise = gate.run(() => fetchCandidates({ title, source }), key).then(async (entries) => {
    await db.putArticle(hash, entries, cacheTtlMs).catch((e) => console.error("[article cache save]", e.message));
    hotArticles.add(hash);
    return entries;
  });
  promise.catch(() => {}); // the leader and every waiting request handle a failure themselves; this only stops Node reporting it as unhandled
  pendingArticles.set(hash, { promise, leaderKey: key });
  try { return { role: "leader", entries: await promise }; }
  finally { pendingArticles.delete(hash); }
}

// Used by processVocab instead of calling Gemini directly. Returns { words }.
async function generateWithCache({ title, text, limit, history, key }) {
  if (!cacheOn) return gate.run(() => generateVocabulary({ title, text, limit, history }), key); // one Gemini call per request, as before
  const source = text.slice(0, MAX_ARTICLE_CHARS);
  if (markKnownWords(source, buildKnown(history)).fresh < MIN_FRESH_WORDS) {
    throw friendlyError("Almost nothing new is left in this article: nearly every word in it is already in your history. Try a different article.");
  }
  const hash = articleHash(source);
  const got = await articleWords({ hash, title, source, key });
  const { words, rejected } = selectWords(got.entries, source, limit, history);

  // The user's history removed cached words and too few are left: one normal per-user call for this user only (the same call as
  // without a cache). If nothing was removed by the history, the article simply has fewer good words, and another call would not help.
  if (words.length < limit && rejected.some((r) => r.reason.startsWith("already learned"))) {
    cacheStats.fallbacks++;
    const result = await gate.run(() => generateVocabulary({ title, text, limit, history }), key);
    // New words it found join the article's list for the next users.
    const extra = result.words;
    db.updateArticleWords(hash, (cached) => mergeWords(cached, extra, stem, CACHE_MAX_WORDS)).catch((e) => console.error("[article cache merge]", e.message));
    return result;
  }
  if (words.length === 0) throw friendlyError(noWordsMessage(history));
  return { words };
}

const queueKey = (user, jobId) => String(user._id) + ":" + jobId;

async function processVocab(user, { title, text, limit, jobId }) {
  // Expired plan = the Free plan: same word range and same daily quota as before (so it cannot be used to generate again and again),
  // but the popup shows only the first FREE_WORDS words and locks the downloads. All the words are generated, charged and saved to the history.
  const free = !db.isActive(user);
  // Check the plan date and today's quota, and subtract the requested words BEFORE generating anything.
  // The history is read at the same time (one round trip less); if the check fails it is simply not used.
  const [q, hist] = await Promise.all([
    db.consume(user.email, limit, { allowExpired: free }),
    db.getHistoryState(user._id).then((state) => ({ state }), (error) => ({ error }))
  ]);
  if (!q.ok) {
    await db.dropJob(user._id, jobId).catch(() => {});
    if (q.reason === "EXPIRED") return { status: 403, body: { code: "PLAN_EXPIRED", error: "Your plan expired on " + q.expiryDate + ". Get premium to keep using NewsVocab." } };
    if (q.reason === "QUOTA") return { status: 429, body: { code: "QUOTA_EXCEEDED", remaining: q.remaining, error: q.remaining > 0
      ? "You can generate only " + q.remaining + " more word" + (q.remaining === 1 ? "" : "s") + " today. Lower the number of words and try again."
      : "You have used all of today's " + db.constants.DAILY_QUOTA + " words. The limit resets tomorrow." } };
    return { status: 401, body: { code: "AUTH_REQUIRED", error: "Please log in with Google to use NewsVocab." } };
  }

  // The user's stored words (a set in the database) are marked with [ ] in the article text before it goes to the AI.
  if (hist.error) {
    await db.refund(user.email, limit).catch(() => {});
    console.error("[history]", hist.error.message);
    const error = "Could not read your history from the database. Please try again.";
    await db.failJob(user._id, jobId, error).catch(() => {});
    return { status: 503, body: { error } };
  }
  const history = hist.state.words;

  let result;
  try {
    // Words come from the article cache when possible; any Gemini call waits in the gate's line if Gemini is already busy with
    // `concurrency` other calls. The popup can ask how long is left (GET /api/vocab/queue) while this request is open.
    result = await generateWithCache({ title: String(title || "").slice(0, 300), text, limit, history, key: queueKey(user, jobId) });
  } catch (e) {
    await db.refund(user.email, limit).catch(() => {}); // generation failed, so the user does not lose those words
    if (e.code === "QUEUE_FULL" || e.code === "QUEUE_TIMEOUT") { // turned away: nothing worth keeping, the user simply tries again
      await db.dropJob(user._id, jobId).catch(() => {});
      return { status: 503, body: { code: "QUEUE_FULL", error: QUEUE_FULL_MESSAGE } };
    }
    const msg = e.status === 401 || e.status === 403 ? "Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env."
      : e.status === 429 ? "Gemini is rate-limited or out of quota right now. Try again in a minute."
      : e.status === 504 ? "Gemini took too long to answer. Please try again."
      : e.friendly ? e.message
      : "Vocabulary generation failed: " + e.message;
    console.error("[generate]", e.message);
    await db.failJob(user._id, jobId, msg).catch(() => {});
    return { status: 502, body: { error: msg } };
  }

  // Fewer words than requested were found: only the words actually returned are charged, the rest go back to today's quota.
  const found = result.words.length;
  let remaining = q.remaining;
  let warning = "";
  let refunding = null; // runs at the same time as the history save below
  if (found < limit) {
    refunding = db.refund(user.email, limit - found).catch((e) => console.error("[refund]", e.message));
    remaining = Math.min(db.constants.DAILY_QUOTA, q.remaining + (limit - found));
    warning = found + " important word" + (found === 1 ? " is" : "s are") + " found";
  }

  // One save: new words get their permanent numbers and their general details go into the shared dictionary (a word that is
  // already there is left as it is), and the numbers are added to the user's history (packed, 3 bytes per word).
  let added = 0;
  try { added = await db.addHistory(user._id, result.words, hist.state); } // reuses the history read at the start
  catch (e) {
    console.error("[history save]", e.message);
    warning = (warning ? warning + ". " : "") + "The words were generated but could not be saved to your history.";
  }
  await refunding;
  const quota = { remainingToday: remaining, validUntil: q.validUntil, historyCount: history.length + added };
  const body = { jobId, words: result.words, ...(warning ? { warning } : {}), ...(free ? { free: true } : {}), quota };
  // The words are now in the user's history, so they must not be lost: keep them for the popup until it confirms it has them.
  const saved = { jobId, words: result.words, ...(warning ? { warning } : {}), ...(free ? { free: true } : {}), quota };
  await db.finishJob(user._id, jobId, saved).catch((e) => console.error("[job save]", e.message));
  return { status: 200, body };
}

async function handleVocab(req, res, user) {
  if (!process.env.GEMINI_API_KEY) {
    return send(res, 503, { error: "The backend has no GEMINI_API_KEY configured. See the README (setup step 2)." });
  }
  const body = await readJson(req, res); if (!body) return;
  const { title, text } = body;
  if (typeof text !== "string" || text.trim().split(/\s+/).length < 100) return send(res, 400, { error: "Article text is missing or too short." });

  const limit = body.wordLimit === undefined ? 10 : body.wordLimit;
  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    return send(res, 400, { error: "wordLimit must be a whole number from " + MIN_LIMIT + " to " + MAX_LIMIT + "." });
  }

  // The Gemini line is full: turn this request away before any database work (no quota used), unless the article is already cached or
  // being fetched right now, because then it needs no Gemini call.
  if (gate.isFull() && !(cacheOn && cacheLikely(articleHash(text.slice(0, MAX_ARTICLE_CHARS))))) {
    return send(res, 503, { code: "QUEUE_FULL", error: QUEUE_FULL_MESSAGE });
  }

  // One request per user at a time (a second click, or a reopened popup, must not spend the quota twice). The popup names its
  // request so it can find the result again; without a valid name the server makes one up.
  const jobId = typeof body.jobId === "string" && JOB_ID.test(body.jobId) ? body.jobId : crypto.randomUUID();
  const claim = await db.claimJob(user._id, jobId);
  if (!claim.ok) return send(res, 409, { code: "IN_PROGRESS", jobId: claim.jobId, error: "Your previous request is still being processed. Wait a few seconds and try again." });

  let outcome;
  try { outcome = await processVocab(user, { title, text, limit, jobId }); }
  catch (e) {
    await db.failJob(user._id, jobId, "Server error. Please try again.").catch(() => {});
    throw e; // answered as a server error by the caller
  }
  // If the popup was closed, this reply goes nowhere. That is fine: the outcome is saved and the popup collects it on its next start.
  send(res, outcome.status, outcome.body);
}

// What the popup asks when it opens after being closed during a request: { status: "none" | "running" | "done" | "failed", jobId, ... }.
async function handleLastResult(res, user) {
  const j = await db.getJob(user._id);
  if (j.status === "none") return send(res, 200, { status: "none" });
  if (j.status === "done") return send(res, 200, { ...j.result, status: "done", jobId: j.jobId });
  if (j.status === "failed") return send(res, 200, { status: "failed", jobId: j.jobId, error: j.error });
  send(res, 200, { status: "running", jobId: j.jobId });
}

// While a request is open the popup asks here how long is left: { state: "none" | "waiting" | "running", position, etaSeconds }.
// Answered from memory only (no database), so many waiting popups cost almost nothing. `jobId` must be the popup's own request.
function handleQueueStatus(req, res, user) {
  const jobId = new URL(req.url, "http://x").searchParams.get("jobId") || "";
  if (!JOB_ID.test(jobId)) return send(res, 200, { state: "none" });
  const key = queueKey(user, jobId);
  let st = gate.status(key);
  // A request that waits for another request's Gemini call (same article) follows that request's place in line.
  if (st.state === "none" && followerOf.has(key)) {
    const lead = gate.status(followerOf.get(key));
    if (lead.state !== "none") st = { state: lead.state, position: lead.position, etaSeconds: lead.etaSeconds + 1 };
  }
  send(res, 200, st);
}

async function handleAck(req, res, user) {
  const body = await readJson(req, res); if (!body) return;
  const done = typeof body.jobId === "string" ? await db.ackJob(user._id, body.jobId) : false;
  send(res, 200, { ok: true, removed: done });
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, aiConfigured: !!process.env.GEMINI_API_KEY, authConfigured: !!process.env.GOOGLE_CLIENT_ID, paymentsConfigured: premium.configured(), paymentMode: premium.pageMode() ? "page" : premium.configured() ? "link" : "off", paymentWebhookConfigured: premium.webhookConfigured(), rewardsEnabled: rewards.config().enabled, model: MODEL, maxWordLimit: MAX_LIMIT, articleCache: { enabled: cacheOn, ...cacheStats }, queue: gate.stats() });

  if (req.method === "POST" && req.url === "/auth/google") return handleGoogleAuth(req, res);
  if (req.method === "POST" && req.url === "/admin/premium") return handleGrantPremium(req, res);
  if ((req.method === "POST" && req.url === "/admin/rewards/decide") || (req.method === "GET" && req.url === "/admin/rewards/pending")) return handleAdminRewards(req, res);
  if (req.method === "POST" && req.url === "/webhook/razorpay") return handleRazorpayWebhook(req, res);

  const known = (req.method === "GET" && (req.url === "/auth/me" || req.url === "/api/history" || req.url === "/api/vocab/last" || req.url === "/api/rewards" || req.url.startsWith("/api/vocab/queue?"))) ||
    (req.method === "POST" && (req.url === "/api/rewards/claim" || req.url === "/api/rewards/redeem" || req.url === "/api/referral/skip" || req.url === "/api/vocab" || req.url === "/api/vocab/ack" || req.url === "/api/premium/checkout" || req.url === "/api/premium/verify"));
  if (!known) return send(res, 404, { error: "Not found" });

  // Everything below needs a logged-in user (verified Google account).
  const user = await auth.userFromRequest(req);
  if (!user) return send(res, 401, { code: "AUTH_REQUIRED", error: "Please log in with Google to use NewsVocab." });

  if (req.url === "/auth/me") return send(res, 200, { user: auth.publicUser(user), account: await accountStatus(user) });
  if (req.url === "/api/history") {
    if (!db.isActive(user)) return send(res, 403, { code: "PLAN_EXPIRED", error: "Downloading your history is a Premium feature. Get Premium to unlock it." });
    const { words, entries } = await db.getHistoryDetails(user._id); // the names oldest first, and the same words with their details from the shared dictionary
    return send(res, 200, { count: words.length, words, entries });
  }
  if (req.url === "/api/vocab/last") return handleLastResult(res, user);
  if (req.url.startsWith("/api/vocab/queue?")) return handleQueueStatus(req, res, user);
  if (req.url === "/api/vocab/ack") return handleAck(req, res, user);
  if (req.url === "/api/rewards") return handleRewardsList(res, user);
  if (req.url === "/api/rewards/claim") return handleRewardClaim(req, res, user);
  if (req.url === "/api/rewards/redeem") return handleRewardRedeem(req, res, user);
  if (req.url === "/api/referral/skip") return handleReferralSkip(res, user);
  if (req.url === "/api/premium/checkout") return handleCheckout(res, user);
  if (req.url === "/api/premium/verify") return handleVerifyPayment(res, user);
  return handleVocab(req, res, user);
}

async function openCollections() {
  if (process.env.NEWSVOCAB_DB === "memory") {
    console.warn("WARNING: NEWSVOCAB_DB=memory, so everything is kept in memory and lost when the server stops. For trying things out only.");
    return require("./memory-db").createMemoryCollections();
  }
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set. Put your MongoDB connection string in backend/.env (see the README, step 3).");
  return require("./mongo").connect({ uri: process.env.MONGODB_URI, dbName: process.env.MONGODB_DB });
}

// `collections` ({ users, histories, dictionary, counters, jobs }) and `opts.today` can be injected by tests.
async function start(collections, opts = {}) {
  collections = collections || await openCollections();
  db = createDb({ users: collections.users, histories: collections.histories, dictionary: collections.dictionary, counters: collections.counters, jobs: collections.jobs, articles: collections.articles, payments: collections.payments, rewards: collections.rewards, timezone: process.env.QUOTA_TIMEZONE, today: opts.today });
  cacheOn = process.env.ARTICLE_CACHE !== "off" && !!collections.articles; // ARTICLE_CACHE=off: every request goes to Gemini
  cacheTtlMs = (parseFloat(process.env.ARTICLE_CACHE_DAYS) > 0 ? parseFloat(process.env.ARTICLE_CACHE_DAYS) : 2) * 24 * 3600 * 1000;
  hotArticles = createRecent(2000); pendingArticles.clear(); followerOf.clear(); Object.keys(cacheStats).forEach((k) => (cacheStats[k] = 0));
  gate = opts.gate || createGate({
    concurrency: Math.max(1, envInt("GEMINI_CONCURRENCY", 30)),
    queueSize: envInt("QUEUE_SIZE", 100),
    maxWaitMs: envInt("QUEUE_MAX_WAIT_MS", 90000),
    initialAvgMs: envInt("GEMINI_EST_SECONDS", 10) * 1000
  });
  premium = createPremium({ db });
  rewards = createRewards({ db });
  auth = createAuth({ clientId: process.env.GOOGLE_CLIENT_ID, secret: SESSION_SECRET, tokeninfoUrl: process.env.GOOGLE_TOKENINFO_URL, db });

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error("[server error]", e && e.stack || e);
      if (!res.headersSent) send(res, 500, { error: "Server error. Please try again." });
    });
  });
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  console.log("NewsVocab backend listening on http://" + (HOST === "127.0.0.1" ? "localhost" : HOST) + ":" + server.address().port + " (model: " + MODEL + ")");
  if (!process.env.GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY is not set; /api/vocab will return an error until it is.");
  if (!premium.configured()) console.warn("WARNING: neither RAZORPAY_PAYMENT_PAGE_URL nor RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET is set; the Get Premium button cannot start a payment until one is.");
  else if (premium.pageMode() && !premium.webhookConfigured()) console.warn("WARNING: RAZORPAY_PAYMENT_PAGE_URL is set but RAZORPAY_WEBHOOK_SECRET is not: a payment made on the page can only be confirmed by the webhook, so no plan will be extended until you add it.");
  else if (!premium.webhookConfigured()) console.warn("NOTE: RAZORPAY_WEBHOOK_SECRET is not set; payments are confirmed only when the popup checks (no webhook).");
  if (!process.env.GOOGLE_CLIENT_ID) console.warn("WARNING: GOOGLE_CLIENT_ID is not set; nobody can sign in until it is.");
  if (!process.env.SESSION_SECRET) console.warn("WARNING: SESSION_SECRET is not set; a random one is used, so users are logged out on every restart.");
  return server;
}

if (require.main === module) {
  start().catch((e) => { console.error("Startup failed: " + e.message); process.exit(1); });
}

module.exports = { start, generateVocabulary };
