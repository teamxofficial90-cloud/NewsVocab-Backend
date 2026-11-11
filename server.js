// NewsVocab backend: keeps the NVIDIA API key on the server, never in the extension.
// Needs the \"mongodb\" npm package (cd backend && npm install). Start with:  NVIDIA_API_KEY=... node server.js
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
const { createSettings } = require("./settings");

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
let db, auth, gate, premium, rewards, settings; // settings (settings.js): the numbers and texts the admin page edits, created in start() too
// premium (Razorpay purchase, see premium.js) is created in start() too; gate (the the AI model queue, see gate.js) is created in start() too
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // protects POST /admin/premium; endpoint is off when empty
const MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3.5-bolt-e4b";
const MAX_ARTICLE_CHARS = 10000; // about 1,600 words; longer articles are cut here (a shorter text is also a faster the AI model call)
const MAX_BODY_BYTES = 400 * 1024;
// The word-count range comes from the admin settings (settings.js; 1 to 13, starting at 10, unless changed there). Read at the moment of use.
const minLimit = () => settings.get().wordLimit.min, maxLimit = () => settings.get().wordLimit.max;
// the AI model traffic control (see gate.js): at most NVIDIA_CONCURRENCY calls run at once, QUEUE_SIZE more wait in line, the rest are turned away.
const envInt = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };
const QUEUE_FULL_MESSAGE = "Sorry, try again";
const NVIDIA_TIMEOUT_MS = envInt("NVIDIA_TIMEOUT_MS", 45000);       // one the AI model call that takes longer than this is cancelled
const NVIDIA_MAX_RETRIES = envInt("NVIDIA_MAX_RETRIES", 2);          // extra tries after a 429/500/503 from the AI model
const NVIDIA_RETRY_BASE_MS = envInt("NVIDIA_RETRY_BASE_MS", 1500);   // waits 1.5 s, then 3 s (doubling) before the retries
const MIN_FRESH_WORDS = 50;      // if fewer unmarked (not yet learned) words than this are in the article, there is nothing new to teach

// Nemotron can "think" before answering. A word list needs no thinking, so it is off by default (faster, cheaper).
// Set NVIDIA_ENABLE_THINKING=1 to turn it on.
const ENABLE_THINKING = /^(1|true|on|yes)$/i.test(process.env.NVIDIA_ENABLE_THINKING || "");
const NVIDIA_MAX_TOKENS = envInt("NVIDIA_MAX_TOKENS", 4096);

const SYSTEM = `You are an expert English teacher who prepares Indian students for competitive exams (SSC CGL/CHSL, IBPS/SBI Bank PO and Clerk, RBI, UPSC, CLAT). You read newspaper articles and editorials and pick the words that are most valuable for the English section of those exams.
Return ONLY a JSON object, with no commentary and no markdown fences.`;

function buildPrompt({ title, text, limit, candidateCount }) {
  return `From the article below, choose ${candidateCount} candidate vocabulary words, best first. The learner needs ${limit} final words, so a few extra candidates are a safety margin.

WHO THE LEARNER IS: a student preparing for Indian government and bank exams. They already know everyday English and common news words. They want words that appear in exam Reading Comprehension passages, Cloze tests, Synonyms/Antonyms questions, One-word substitution and Error spotting.

CHOOSE words that are:
- upper-intermediate to advanced: the kind of word an educated reader may still need to look up (for example: scrutinise, mitigate, exacerbate, ambivalent, expedite, culpable, tenuous);
- common in editorials, formal writing and exam passages, and useful again in other contexts;
- good for exam questions: they have clear synonyms or antonyms, or are easily confused with a similar word (for example discrepancy / disparity);
- used in the article in a sense that its context makes clear.

SKIP: everyday or easy words, even if they appear in the news (for example: claim, misleading, report, serious, important, increase, decision, support, issue); names of people, places or organisations; dates, numbers, abbreviations; words chosen only because they are long; words that are only technical terms of one narrow field. No duplicates, and no two words from the same word family (for example not both "regulate" and "regulatory").
If the article has few hard words, choose the hardest ones it has. Never invent a word that is not in the article.
Order: put the words with the highest exam value first.

IMPORTANT: in the article text, every word the learner has already studied is wrapped in square brackets, like [stalled]. Never choose a bracketed word or any other form of it. You may still use bracketed words to understand the context. The brackets are not part of the article: never put them in any field of your answer.

Each "word" must be ONE word, copied exactly as spelled in the article, in lower case.

For each word give ONE JSON object with exactly these keys, keeping every text short:
- "word": the word
- "partOfSpeech": its part of speech (as used in the article)
- "meaningInContext": what it means in THIS article (max 15 words)
- "simpleMeaning": the general dictionary meaning in plain English, as a learner would find it in a good dictionary. It must NOT mention this article, its people, places or events (max 12 words)
- "exampleSentence": an ORIGINAL example sentence in a formal, news or exam style (max 18 words, not copied from the article, not about the article's story) using the same meaning and the same word
- "synonyms": an array of 2 or 3 true synonyms (single words, lower case) that could replace the word in a synonym question; leave out words that are only loosely related
- "antonyms": an array of 1 to 3 true opposites (single words, lower case) that would be correct in an antonym question; use [] if there is no real antonym; never force a weak one

JSON rules: output valid JSON only. Use plain double quotes for keys and strings; never put a double quote inside a text value (use a single quote instead); no trailing commas.

Output format: {"words":[{"word":"...","partOfSpeech":"...","meaningInContext":"...","simpleMeaning":"...","exampleSentence":"...","synonyms":["..."],"antonyms":["..."]}]}

ARTICLE TITLE: ${title}

ARTICLE TEXT:
${text}`;
}


let jsonModeOk = process.env.NVIDIA_JSON_MODE !== "off"; // asks the server to guarantee valid JSON; switched off for good if the endpoint rejects it
async function callModel(prompt, model = MODEL) {
  const url = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com") + "/v1/chat/completions";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(NVIDIA_TIMEOUT_MS),
      headers: { "content-type": "application/json", "accept": "application/json", "authorization": "Bearer " + process.env.NVIDIA_API_KEY },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
        temperature: 0.3,
        top_p: 0.95,
        max_tokens: NVIDIA_MAX_TOKENS,
        stream: false,
        ...(jsonModeOk ? { response_format: { type: "json_object" } } : {}),
        chat_template_kwargs: { enable_thinking: ENABLE_THINKING }
      })
    });
  } catch (e) {
    if (e && e.name === "TimeoutError") { const err = new Error("The AI model took too long to answer."); err.status = 504; throw err; }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && ((data.error && data.error.message) || data.detail || data.message)) || "HTTP " + res.status;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg)); err.status = res.status;
    if (res.status === 400 && jsonModeOk && /response_format|json_object|guided|unsupported/i.test(err.message)) {
      jsonModeOk = false; console.warn("The model does not accept response_format; JSON mode is switched off."); return callModel(prompt, model);
    }
    throw err;
  }
  const choice = data.choices && data.choices[0];
  let text = (choice && choice.message && choice.message.content) || "";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); // in case the model returns its thinking inline
  if (!text) throw new Error("The AI model returned no text" + (choice && choice.finish_reason ? " (" + choice.finish_reason + ")" : "") + ".");
  return text;
}

// callModel, plus a short wait and another try when the model says it is busy (429/500/503). The caller still holds its place in the
// gate meanwhile, so retries cannot pile extra load on top of the limit.
async function callModelWithRetry(prompt, model) {
  for (let attempt = 0; ; attempt++) {
    try { return await callModel(prompt, model); }
    catch (e) {
      const busy = e.status === 429 || e.status === 500 || e.status === 503;
      if (!busy || attempt >= NVIDIA_MAX_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, NVIDIA_RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

// Asks the model and parses its answer. If the JSON is broken beyond repair, asks once more (a different sample usually works).
async function askForWords(prompt, model) {
  for (let attempt = 0; ; attempt++) {
    const raw = await callModelWithRetry(prompt, model);
    try { return normalizeCandidates(parseJsonLoose(raw)); }
    catch (e) {
      console.error("[model] unreadable answer (" + e.message + "): " + raw.slice(0, 200).replace(/\s+/g, " "));
      if (attempt >= 1) { const err = new Error("The AI returned an unreadable answer. Please try again."); err.friendly = true; err.status = 502; throw err; }
    }
  }
}

// `history` is the array of words the learner already knows. In the final text sent to the AI model, the article (cut at
// MAX_ARTICLE_CHARS) is kept and every history word is wrapped in [ ]. The same cut text is used to validate the AI model's answer.
// ONE the AI model call only: if fewer than `limit` valid new words come back, the caller gets just those (never a second call).
async function generateVocabulary({ title, text, limit, history, model }) {
  const source = text.slice(0, MAX_ARTICLE_CHARS);
  const marked = markKnownWords(source, buildKnown(history)); // one O(n) pass, O(1) Set lookups
  if (marked.fresh < MIN_FRESH_WORDS) {
    const err = new Error("Almost nothing new is left in this article: nearly every word in it is already in your history. Try a different article.");
    err.friendly = true; throw err;
  }
  const candidateCount = Math.min(limit + 6, 30); // a few extra, because candidates that fail validation are skipped (the exam-level prompt rejects more; less output = faster)
  const candidates = await askForWords(buildPrompt({ title, text: marked.text, limit, candidateCount }), model);
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
// otherwise an account is created for it (no free days: the trial is a paid plan, see premium.js).
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

// Manual grant (support, refunds): POST /admin/premium { email, plan? } gives the 1-week ("week"), 1-month ("month", the default) or 2-month ("twomonth") plan from today,
// with the length set in the admin settings. Normal purchases go through Razorpay instead (see premium.js).
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
  const plan = body.plan === undefined ? "month" : body.plan;
  if (!["week", "month", "twomonth"].includes(plan)) return send(res, 400, { error: 'plan must be "week", "month" or "twomonth".' });
  const user = typeof body.email === "string" ? await db.grantPlan(body.email, plan) : null;
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

// Starts a purchase: body { plan: "trial" | "week" | "month" | "twomonth" } ("premium" or no plan = "month"). Creates the Razorpay payment page for that plan
// at the price set in the admin settings and returns its address { url }. Logged-in users only (the same session token as the other /api calls).
async function handleCheckout(req, res, user) {
  const raw = await readRaw(req, res); if (!raw) return;
  let plan = "month";
  try {
    const b = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (b && b.plan !== undefined && b.plan !== "premium") plan = String(b.plan);
  } catch (e) { return send(res, 400, { error: "Invalid JSON body." }); }
  try { const r = await premium.createCheckout(user, plan); send(res, 200, { url: r.url, ...(r.pageMode ? { pageMode: true, email: user.email } : {}) }); }
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

// The popup can be closed while the AI model is still working (Chrome closes it on any click elsewhere). The server keeps going anyway,
// so every request is recorded as a "job" (see db.js): whatever happens, the outcome is saved for an hour and the popup can ask for it
// the next time it opens (GET /api/vocab/last), then confirm it has the words (POST /api/vocab/ack).
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Does the work of one request and returns { status, body }. The job document says "running" while this runs, and ends as "done"
// (the words), "failed" (the message) or removed (nothing worth keeping).
// ----- Article cache -----
// The first user to read an article makes ONE the AI model call that picks CACHE_CANDIDATES words for the article itself (nothing about any
// user goes into it). Everybody after that gets the first words from that list that are not in their own history: no the AI model call, an
// instant answer. If a user's history leaves too few, that one user gets a normal per-user call (generateVocabulary), and any new words
// it finds are added to the list. ARTICLE_CACHE=off turns all of this off.
const CACHE_CANDIDATES = 30;   // words asked from the AI model for a new article
const CACHE_MAX_WORDS = 60;    // most words kept per article, after per-user calls have added some
let cacheOn = false, cacheTtlMs = 0;
let hotArticles = createRecent(2000);          // hashes cached or being fetched on this server: lets a cached article through a full line
const pendingArticles = new Map();             // hash -> { promise, leaderKey } while the first request for an article is at the AI model
const followerOf = new Map();                  // queue key of a request waiting for another request's the AI model call -> that request's queue key
const cacheStats = { hits: 0, waited: 0, misses: 0, fallbacks: 0 }; // shown by /health
const cacheLikely = (hash) => pendingArticles.has(hash) || hotArticles.has(hash);
const friendlyError = (message) => { const e = new Error(message); e.friendly = true; return e; };
const noWordsMessage = (history) => history.length > 0
  ? "No new words could be found in this article that are not already in your history. Try a different article."
  : "No suitable vocabulary words could be found in this article. Try a different article.";

// The one the AI model call for a new article: the whole article (nothing marked), CACHE_CANDIDATES words, checked like any other answer.
async function fetchCandidates({ title, source }) {
  const candidates = await askForWords(buildPrompt({ title, text: source, limit: maxLimit(), candidateCount: CACHE_CANDIDATES }));
  const { words } = selectWords(candidates, source, CACHE_CANDIDATES, []);
  if (words.length === 0) throw friendlyError(noWordsMessage([]));
  return words;
}

// The article's candidate words: from the database (hit), from the request that is already asking the AI model (waited), or by asking the AI model
// now (leader). Concurrent requests for the same new article therefore cost one the AI model call, not one each.
async function articleWords({ hash, title, source, key }) {
  let pending = pendingArticles.get(hash);
  if (!pending) {
    const cached = await db.getArticle(hash);
    if (cached) { cacheStats.hits++; hotArticles.add(hash); return { role: "hit", entries: cached }; }
    pending = pendingArticles.get(hash); // a request may have started asking the AI model while we asked the database
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

// Used by processVocab instead of calling the AI model directly. Returns { words }.
async function generateWithCache({ title, text, limit, history, key }) {
  if (!cacheOn) return gate.run(() => generateVocabulary({ title, text, limit, history }), key); // one the AI model call per request, as before
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
  // but only the first FREE_WORDS words ever leave the server and are saved to the history (so no edited popup can show or export more, and the history file of a
  // Free user holds only those words). The full number of words is still generated and charged against today's quota.
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
    // Words come from the article cache when possible; any the AI model call waits in the gate's line if the AI model is already busy with
    // `concurrency` other calls. The popup can ask how long is left (GET /api/vocab/queue) while this request is open.
    result = await generateWithCache({ title: String(title || "").slice(0, 300), text, limit, history, key: queueKey(user, jobId) });
  } catch (e) {
    await db.refund(user.email, limit).catch(() => {}); // generation failed, so the user does not lose those words
    if (e.code === "QUEUE_FULL" || e.code === "QUEUE_TIMEOUT") { // turned away: nothing worth keeping, the user simply tries again
      await db.dropJob(user._id, jobId).catch(() => {});
      return { status: 503, body: { code: "QUEUE_FULL", error: QUEUE_FULL_MESSAGE } };
    }
    const msg = e.status === 401 || e.status === 403 ? "NVIDIA rejected the API key. Check NVIDIA_API_KEY in backend/.env."
      : e.status === 429 ? "the AI model is rate-limited or out of quota right now. Try again in a minute."
      : e.status === 504 ? "the AI model took too long to answer. Please try again."
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
  // A Free user gets, and keeps in the history, only the first FREE_WORDS words. The others are neither returned, nor stored in the saved job result, nor in the history
  // (so they can still be found in a later article once the user has paid).
  const shown = free ? result.words.slice(0, db.constants.FREE_WORDS) : result.words;
  const hidden = result.words.length - shown.length;
  let added = 0;
  try { if (shown.length) added = await db.addHistory(user._id, shown, hist.state); } // reuses the history read at the start
  catch (e) {
    console.error("[history save]", e.message);
    warning = (warning ? warning + ". " : "") + "The words were generated but could not be saved to your history.";
  }
  await refunding;
  const quota = { remainingToday: remaining, validUntil: q.validUntil, historyCount: history.length + added };
  const body = { jobId, words: shown, ...(warning ? { warning } : {}), ...(free ? { free: true, hidden } : {}), quota };
  // The words are now in the user's history, so they must not be lost: keep them for the popup until it confirms it has them.
  const saved = { jobId, words: shown, ...(warning ? { warning } : {}), ...(free ? { free: true, hidden } : {}), quota };
  await db.finishJob(user._id, jobId, saved).catch((e) => console.error("[job save]", e.message));
  return { status: 200, body };
}

async function handleVocab(req, res, user) {
  if (!process.env.NVIDIA_API_KEY) {
    return send(res, 503, { error: "The backend has no NVIDIA_API_KEY configured. See the README (setup step 2)." });
  }
  const body = await readJson(req, res); if (!body) return;
  const { title, text } = body;
  if (typeof text !== "string" || text.trim().split(/\s+/).length < 100) return send(res, 400, { error: "Article text is missing or too short." });

  const limit = body.wordLimit === undefined ? settings.get().wordLimit.default : body.wordLimit;
  if (!Number.isInteger(limit) || limit < minLimit() || limit > maxLimit()) {
    return send(res, 400, { error: "wordLimit must be a whole number from " + minLimit() + " to " + maxLimit() + "." });
  }

  // The the AI model line is full: turn this request away before any database work (no quota used), unless the article is already cached or
  // being fetched right now, because then it needs no the AI model call.
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
  if (j.status === "done") {
    // The plan may have expired while the popup was closed: a result made under the full plan is cut to the Free words when it is collected.
    const r = j.result || {}, keep = db.constants.FREE_WORDS;
    if (!db.isActive(user) && Array.isArray(r.words) && r.words.length > keep) {
      return send(res, 200, { ...r, words: r.words.slice(0, keep), free: true, hidden: r.words.length - keep, status: "done", jobId: j.jobId });
    }
    return send(res, 200, { ...r, status: "done", jobId: j.jobId });
  }
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
  // A request that waits for another request's the AI model call (same article) follows that request's place in line.
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

// ----- Admin-editable settings (settings.js) -----
// GET  /config           public (no login, no secrets): what the popup needs. Cached for 30 s by browsers and proxies.
// GET  /admin/settings   { settings, defaults, updated }          (x-admin-key)
// POST /admin/settings   { settings } -> { settings, updated }, or 400 { error, errors: { field: message } }   (x-admin-key)
async function handleConfig(res) {
  await settings.refresh().catch(() => {}); // a fresh read: the popup must not show prices that are older than the server's own
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=30" });
  const cur = settings.get();
  res.end(JSON.stringify({ settings: { ...cur, plans: { ...cur.plans, premium: cur.plans.month } } })); // `premium` = the 1-month plan, for popups from before the three plans
}
async function handleAdminSettings(req, res) {
  if (!adminOk(req, res)) return;
  if (req.method === "GET") return send(res, 200, await settings.view());
  const body = await readJson(req, res); if (!body) return;
  try {
    const r = await settings.save(body.settings);
    if (!r.ok) { // errors as a list [{ field, message }], the form the admin page shows next to each field
      const list = Object.entries(r.errors).map(([field, message]) => ({ field, message }));
      return send(res, 400, { error: list[0].message + (list.length > 1 ? " (" + (list.length - 1) + " more to fix.)" : ""), errors: list });
    }
    send(res, 200, { settings: r.settings, updated: r.updated });
  } catch (e) { console.error("[settings]", e.message); send(res, e.status || 500, { error: e.status ? e.message : "Could not save the settings. Please try again." }); }
}

// Keep-alive for an uptime monitor (UptimeRobot, cron-job.org): GET or HEAD /ping. The reply is tiny and carries no settings.
// It also reads the database at most once every 6 hours, so an idle Atlas free cluster keeps seeing a connection.
const DB_PING_EVERY_MS = 6 * 60 * 60 * 1000;
const DB_PING_TIMEOUT_MS = 5000;
let lastDbPing = { at: 0, ok: null };
async function handlePing(req, res) {
  const t = Date.now();
  if (t - lastDbPing.at >= DB_PING_EVERY_MS) {
    lastDbPing.at = t; // set first, so a burst of pings starts only one check
    try {
      await Promise.race([db.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), DB_PING_TIMEOUT_MS).unref())]);
      lastDbPing.ok = true;
    } catch (e) {
      lastDbPing.ok = false;
      console.error("[ping] database check failed:", e && e.message || e);
    }
  }
  send(res, 200, { ok: true, db: lastDbPing.ok });
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if ((req.method === "GET" || req.method === "HEAD") && (req.url === "/ping" || req.url.startsWith("/ping?"))) return handlePing(req, res);
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, aiConfigured: !!process.env.NVIDIA_API_KEY, authConfigured: !!process.env.GOOGLE_CLIENT_ID, paymentsConfigured: premium.configured(), paymentMode: premium.pageMode() ? "page" : premium.configured() ? "link" : "off", paymentWebhookConfigured: premium.webhookConfigured(), rewardsEnabled: rewards.config().enabled, model: MODEL, maxWordLimit: maxLimit(), articleCache: { enabled: cacheOn, ...cacheStats }, queue: gate.stats() });

  if (req.method === "GET" && (req.url === "/config" || req.url.startsWith("/config?"))) return handleConfig(res);
  if ((req.method === "GET" || req.method === "POST") && req.url === "/admin/settings") return handleAdminSettings(req, res);
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
  if (req.url === "/api/premium/checkout") return handleCheckout(req, res, user);
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
  settings = createSettings({ collection: collections.settings }); // before createDb: db reads the quota, plan lengths and Free words from it
  await settings.refresh();
  db = createDb({ users: collections.users, histories: collections.histories, dictionary: collections.dictionary, counters: collections.counters, jobs: collections.jobs, articles: collections.articles, payments: collections.payments, rewards: collections.rewards, settings, timezone: process.env.QUOTA_TIMEZONE, today: opts.today });
  cacheOn = process.env.ARTICLE_CACHE !== "off" && !!collections.articles; // ARTICLE_CACHE=off: every request goes to the AI model
  cacheTtlMs = (parseFloat(process.env.ARTICLE_CACHE_DAYS) > 0 ? parseFloat(process.env.ARTICLE_CACHE_DAYS) : 2) * 24 * 3600 * 1000;
  lastDbPing = { at: 0, ok: null };
  hotArticles = createRecent(2000); pendingArticles.clear(); followerOf.clear(); Object.keys(cacheStats).forEach((k) => (cacheStats[k] = 0));
  gate = opts.gate || createGate({
    concurrency: Math.max(1, envInt("NVIDIA_CONCURRENCY", envInt("GEMINI_CONCURRENCY", 5))),
    queueSize: envInt("QUEUE_SIZE", 100),
    maxWaitMs: envInt("QUEUE_MAX_WAIT_MS", 90000),
    initialAvgMs: envInt("NVIDIA_EST_SECONDS", envInt("GEMINI_EST_SECONDS", 5)) * 1000
  });
  premium = createPremium({ db, settings });
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
  if (!process.env.NVIDIA_API_KEY) console.warn("WARNING: NVIDIA_API_KEY is not set; /api/vocab will return an error until it is.");
  if (!premium.configured()) console.warn("WARNING: none of RAZORPAY_PAGE_MODE=on, RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET or a RAZORPAY_*_PAGE_URL is set, so no payment can be confirmed.");
  else if (premium.pageMode() && !premium.webhookConfigured()) console.warn("WARNING: payment page mode is on but RAZORPAY_WEBHOOK_SECRET is not: a payment made on a payment page can only be confirmed by the webhook, so no plan will be extended until you add it.");
  else if (!premium.webhookConfigured()) console.warn("NOTE: RAZORPAY_WEBHOOK_SECRET is not set; payments are confirmed only when the popup checks (no webhook).");
  if (premium.pageMode() && ["RAZORPAY_TRIAL_PAGE_URL", "RAZORPAY_WEEK_PAGE_URL", "RAZORPAY_PAYMENT_PAGE_URL", "RAZORPAY_MONTH_PAGE_URL", "RAZORPAY_TWOMONTH_PAGE_URL"].some((k) => process.env[k])) { const missing = [["RAZORPAY_TRIAL_PAGE_URL", "trial"], ["RAZORPAY_WEEK_PAGE_URL", "1-week"], ["RAZORPAY_PAYMENT_PAGE_URL", "1-month"], ["RAZORPAY_TWOMONTH_PAGE_URL", "2-month"]].filter(([k]) => !process.env[k] && !(k === "RAZORPAY_PAYMENT_PAGE_URL" && process.env.RAZORPAY_MONTH_PAGE_URL)); if (missing.length) console.warn("WARNING: payment page mode needs one Razorpay payment page per plan; missing: " + missing.map(([k, n]) => k + " (" + n + ")").join(", ") + ". A plan whose page is missing cannot be bought."); }
  if (!process.env.GOOGLE_CLIENT_ID) console.warn("WARNING: GOOGLE_CLIENT_ID is not set; nobody can sign in until it is.");
  if (!process.env.SESSION_SECRET) console.warn("WARNING: SESSION_SECRET is not set; a random one is used, so users are logged out on every restart.");
  return server;
}

if (require.main === module) {
  start().catch((e) => { console.error("Startup failed: " + e.message); process.exit(1); });
}

module.exports = { start, generateVocabulary };