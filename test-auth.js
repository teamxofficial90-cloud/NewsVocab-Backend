// End-to-end backend test: single Google sign-in flow, sessions, quota, history and premium, using a mock
// Google tokeninfo server, the mock Gemini server (../scripts/mock-gemini.js) and in-memory collections.
// Run: node test-auth.js
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path");
const { spawn } = require("child_process");
const assert = require("assert");

const CLIENT = "test-client.apps.googleusercontent.com";
const exp = () => String(Math.floor(Date.now() / 1000) + 3600);
const tokens = {
  alice: { aud: CLIENT, iss: "https://accounts.google.com", exp: exp(), email_verified: "true", sub: "111", email: "Alice@Gmail.com", name: "Alice" },
  wrongaud: { aud: "other", iss: "accounts.google.com", exp: exp(), email_verified: "true", sub: "222", email: "x@gmail.com" },
  unverified: { aud: CLIENT, iss: "accounts.google.com", exp: exp(), email_verified: "false", sub: "333", email: "y@gmail.com" }
};
const pad = (k) => k + "_" + "x".repeat(30); // ids must look like real tokens (>= 20 chars)

const mockGoogle = http.createServer((req, res) => {
  const t = new URL(req.url, "http://x").searchParams.get("id_token") || "";
  const claims = tokens[t.split("_")[0]];
  res.writeHead(claims ? 200 : 400, { "content-type": "application/json" });
  res.end(JSON.stringify(claims || { error: "invalid_token" }));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r));
  const mockLog = path.join(os.tmpdir(), "nv-mock-" + Date.now() + ".jsonl");
  const geminiPort = 19000 + Math.floor(Math.random() * 900);
  const gem = spawn("node", [path.join(__dirname, "..", "scripts", "mock-gemini.js")], { env: { ...process.env, MOCK_PORT: String(geminiPort), MOCK_LOG: mockLog }, stdio: "ignore" });
  Object.assign(process.env, {
    PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", ADMIN_KEY: "adm1n",
    GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port, GEMINI_API_KEY: "goodkey", GEMINI_THINKING_CONFIG: '{"thinkingBudget":0}', GEMINI_BASE_URL: "http://127.0.0.1:" + geminiPort,
    ARTICLE_CACHE: "off" // this test checks the per-user Gemini path (history marking, refunds); the cache has its own test (test-cache.js)
  });
  const { start } = require("./server");
  const { createMemoryCollections } = require("./memory-db");
  const { addDays } = require("./db");
  const { unpack } = require("./pack");
  const wordsOfHistory = () => cols.histories.docs[0].ids ? unpack(cols.histories.docs[0].ids).map((id) => cols.dictionary.docs.find((d) => d._id === id).w) : [];
  const countOfHistory = () => unpack(cols.histories.docs[0].ids).length;

  const cols = createMemoryCollections();
  let today = "2026-10-19";
  const server = await start(cols, { today: () => today });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const mockLines = () => fs.readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const article = { title: "T", text: Array.from({ length: 150 }, (_, i) => "filler" + i).join(" ") + " " +
    "draconian stringent ambiguous contentious intransigent exacerbated conciliatory stalled gridlock ensuing pragmatic mounting scrutiny rhetoric volatile culpable mitigate bolster curtail precarious resilient unprecedented advocate scrupulous tenuous impetus repercussions formidable dwindling salient ostensibly burgeoning plausible ephemeral staunch lucid arduous discord vindicate cogent" };

  try {
    for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:" + geminiPort); break; } catch (e) { await sleep(100); } }
    let r;
    // --- nothing works without logging in ---
    r = await call("POST", "/api/vocab", { text: "x" }); assert.equal(r.status, 401); assert.equal(r.body.code, "AUTH_REQUIRED");
    r = await call("GET", "/auth/me"); assert.equal(r.status, 401);
    r = await call("GET", "/api/history"); assert.equal(r.status, 401);

    // --- Google verification ---
    r = await call("POST", "/auth/google", { idToken: pad("wrongaud") }); assert.equal(r.status, 401, "wrong audience");
    r = await call("POST", "/auth/google", { idToken: pad("unverified") }); assert.equal(r.status, 401, "unverified email");
    r = await call("POST", "/auth/google", { idToken: pad("nobody") }); assert.equal(r.status, 401, "invalid token");
    r = await call("POST", "/auth/google", { idToken: "short" }); assert.equal(r.status, 400);
    assert.equal(cols.users.docs.length, 0, "failed sign-ins create nothing");

    // --- one button: new Gmail = signup, known Gmail = login ---
    r = await call("POST", "/auth/google", { idToken: pad("alice") });
    assert.equal(r.status, 200); assert.equal(r.body.isNewUser, true); assert.equal(r.body.user.email, "alice@gmail.com");
    assert.equal(r.body.account.remainingToday, 13); assert.equal(r.body.account.validUntil, "2026-10-23", "5 trial days: signup day + 4");
    const session = r.body.token;
    assert.equal(cols.users.docs.length, 1); assert.equal(cols.histories.docs.length, 1, "one history document per user");
    assert.equal(cols.users.docs[0].expiry_date, "2026-10-24"); assert.equal(cols.users.docs[0].daily_quota, 13);
    r = await call("POST", "/auth/google", { idToken: pad("alice") });
    assert.equal(r.status, 200); assert.equal(r.body.isNewUser, false, "second time is a login");
    assert.equal(cols.users.docs.length, 1, "still one account"); assert.equal(cols.histories.docs.length, 1);

    // --- sessions ---
    r = await call("GET", "/auth/me", null, session); assert.equal(r.status, 200); assert.equal(r.body.user.email, "alice@gmail.com"); assert.equal(r.body.account.historyCount, 0);
    r = await call("GET", "/auth/me", null, session.slice(0, -2) + "xx"); assert.equal(r.status, 401, "tampered token");
    r = await call("GET", "/auth/me", null, "garbage"); assert.equal(r.status, 401);

    // --- request validation never costs quota ---
    r = await call("POST", "/api/vocab", { text: "x" }, session); assert.equal(r.status, 400, "short article");
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 14 }, session); assert.equal(r.status, 400, "above max 13");
    assert.equal(cols.users.docs[0].daily_quota, 13);

    // --- generate 5: quota and last_used are saved, history holds only the words ---
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 5 }, session);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.words.length, 5);
    assert.equal(r.body.quota.remainingToday, 8); assert.equal(r.body.quota.historyCount, 5);
    assert.equal(cols.users.docs[0].daily_quota, 8); assert.equal(cols.users.docs[0].last_used, today);
    assert.deepStrictEqual(wordsOfHistory(), r.body.words.map((w) => w.word));
    assert.deepStrictEqual(Object.keys(cols.histories.docs[0]).sort(), ["_id", "ids", "user_id", "ver", "word_count"], "only packed word numbers, their count and a version are stored: no words, no meanings");
    assert.equal(cols.histories.docs[0].ids.length, 5 * 3, "3 bytes per word");
    assert.equal(cols.histories.docs[0].word_count, 5);
    const first = r.body.words.map((w) => w.word);
    // the answer carries synonyms and antonyms, and the shared dictionary got one document per word (general details only)
    assert.ok(r.body.words.every((w) => Array.isArray(w.synonyms) && w.synonyms.length === 2 && Array.isArray(w.antonyms) && w.antonyms.length === 1), "synonyms and antonyms are returned");
    assert.deepStrictEqual(cols.dictionary.docs.map((d) => d.w), first, "one dictionary document per generated word");
    assert.deepStrictEqual(cols.dictionary.docs.map((d) => d._id), [1, 2, 3, 4, 5], "numbered from 1, permanent");
    assert.deepStrictEqual(Object.keys(cols.dictionary.docs[0]).sort(), ["_id", "ant", "ex", "m", "pos", "syn", "w"], "dictionary documents hold the number, the word and the general details");
    assert.ok(/^Plain meaning of /.test(cols.dictionary.docs[0].m) && !JSON.stringify(cols.dictionary.docs).includes("in this article"), "the article-specific meaning is not stored");
    assert.ok(/prompt|ARTICLE/.test(mockLines()[0].prompt) && /array of 2 or 3 common synonyms/.test(mockLines()[0].prompt), "the prompt asks for synonyms and antonyms");
    assert.ok(mockLines()[0].article.includes("draconian"), "empty history: the whole article goes to the AI");
    assert.deepStrictEqual(mockLines()[0].thinkingConfig, { thinkingBudget: 0 }, "GEMINI_THINKING_CONFIG is sent to the model");
    assert.equal(mockLines()[0].candidateCount, 5 + 3, "only 3 extra candidates are requested");
    assert.ok(!/excerpt/i.test(mockLines()[0].prompt), "the optional excerpt field is no longer requested");

    // --- second request: the stored words are wrapped in [ ] inside the full article; no history list is sent ---
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 5, previousWords: ["ignored-client-value"] }, session);
    assert.equal(r.status, 200); assert.equal(r.body.quota.remainingToday, 3); assert.equal(r.body.quota.historyCount, 10);
    const sent = mockLines().pop();
    const sentTokens = new Set(sent.article.split(/\s+/));
    for (const w of first) assert.ok(sentTokens.has("[" + w + "]") && !sentTokens.has(w), w + " is sent inside [ ]");
    assert.ok(sentTokens.has("filler0") && sentTokens.has("pragmatic"), "every other word is sent as it was");
    assert.equal(sent.article.replace(/[\[\]]/g, ""), article.text, "the whole article is kept: without the brackets it is identical");
    assert.equal(sent.promptHasHistoryList, false, "the prompt no longer lists the history");
    assert.ok(r.body.words.every((w) => !first.includes(w.word)), "no repeated words (the backend check also catches words the AI returns anyway)");
    assert.equal(countOfHistory(), 10);

    // --- not enough quota left ---
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 6 }, session); assert.equal(r.status, 429); assert.equal(r.body.remaining, 3); assert.match(r.body.error, /only 3 more words/);
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 3 }, session); assert.equal(r.status, 200); assert.equal(r.body.quota.remainingToday, 0);
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 1 }, session); assert.equal(r.status, 429); assert.match(r.body.error, /used all of today/);

    // --- Excel data ---
    r = await call("GET", "/api/history", null, session); assert.equal(r.status, 200); assert.equal(r.body.count, 13);
    assert.ok(r.body.words.every((w) => typeof w === "string"), "history is a plain list of words");
    assert.equal(r.body.entries.length, 13, "the history file data has details for every word");
    assert.deepStrictEqual(r.body.entries.map((e) => e.word), r.body.words, "same order as the history");
    assert.ok(r.body.entries.every((e) => e.meaning && e.example && e.partOfSpeech && e.synonyms.length === 2 && e.antonyms.length === 1), "meaning, example, part of speech, synonyms, antonyms");
    assert.equal(cols.dictionary.docs.length, 13, "13 words learned, 13 dictionary documents");

    // --- a new day: quota starts again at 13; a failed generation is refunded and not recorded ---
    today = addDays(today, 1);
    r = await call("GET", "/auth/me", null, session); assert.equal(r.body.account.remainingToday, 13);
    // an article where almost everything is already known: refused before calling the AI, and the words are refunded
    const savedIds = cols.histories.docs[0].ids; cols.dictionary.docs.push({ _id: 999, w: "filler", pos: "", m: "", ex: "", syn: [], ant: [] });
    cols.histories.docs[0].ids = Buffer.concat([Buffer.from(savedIds), Buffer.from([0, 3, 231])]); // number 999
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 5 }, session); assert.equal(r.status, 502); assert.match(r.body.error, /Almost nothing new/);
    assert.equal(cols.users.docs[0].daily_quota, 13, "refunded"); cols.histories.docs[0].ids = savedIds; cols.dictionary.docs.pop();
    process.env.GEMINI_API_KEY = "badkey";
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 10 }, session); assert.equal(r.status, 502);
    assert.equal(cols.users.docs[0].daily_quota, 13, "failed generation is refunded"); assert.equal(countOfHistory(), 13, "and not recorded");
    process.env.GEMINI_API_KEY = "goodkey";

    // --- fewer valid words than requested: ONE Gemini call, only the found words are charged, "N important words are found" ---
    const fillers = Array.from({ length: 150 }, (_, i) => "filler" + i).join(" ");
    let calls = mockLines().length;
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " cogent vindicate discord" }, session); // limit defaults to 10
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual(r.body.words.map((w) => w.word).sort(), ["cogent", "discord", "vindicate"]); // the mock answers in its own order
    assert.equal(r.body.warning, "3 important words are found");
    assert.equal(mockLines().length, calls + 1, "no second Gemini call");
    assert.equal(r.body.quota.remainingToday, 10, "13 - 10 requested + 7 given back"); assert.equal(cols.users.docs[0].daily_quota, 10);
    assert.equal(countOfHistory(), 16, "the found words are recorded");
    calls = mockLines().length;
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " lucid", wordLimit: 4 }, session);
    assert.equal(r.status, 200); assert.equal(r.body.warning, "1 important word is found"); assert.equal(r.body.quota.remainingToday, 9);
    assert.equal(mockLines().length, calls + 1); assert.equal(cols.users.docs[0].daily_quota, 9);
    // nothing usable at all: an error, one call, everything given back
    calls = mockLines().length;
    r = await call("POST", "/api/vocab", { title: "T", text: fillers, wordLimit: 5 }, session);
    assert.equal(r.status, 502); assert.match(r.body.error, /No new words could be found/); assert.equal(mockLines().length, calls + 1);
    assert.equal(cols.users.docs[0].daily_quota, 9, "nothing charged");
    // the article sent to Gemini is cut at 10,000 characters
    calls = mockLines().length;
    r = await call("POST", "/api/vocab", { title: "T", text: Array.from({ length: 3000 }, (_, i) => "filler" + i).join(" ") + " cogent", wordLimit: 1 }, session);
    assert.equal(r.status, 502, "the only valid word is beyond the cut"); assert.ok(mockLines().pop().article.length <= 10000);
    assert.equal(cols.users.docs[0].daily_quota, 9);


    // --- the popup is closed while the answer is being made: the words are kept for it ---
    r = await call("GET", "/api/vocab/last"); assert.equal(r.status, 401, "needs a login");
    r = await call("POST", "/api/vocab/ack", { jobId: "x" }); assert.equal(r.status, 401, "needs a login");
    r = await call("GET", "/api/vocab/last", null, session); assert.equal(r.body.status, "failed", "the outcome of the previous (failed) test request is still held");
    await call("POST", "/api/vocab/ack", { jobId: r.body.jobId }, session);
    r = await call("GET", "/api/vocab/last", null, session); assert.deepStrictEqual(r.body, { status: "none" }, "confirmed: nothing held");
    // a normal request: the popup gets the words at once, and the server holds them until the popup confirms
    const hBefore = countOfHistory();
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " arduous staunch", wordLimit: 2, jobId: "test-job-0001" }, session);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.jobId, "test-job-0001"); assert.equal(r.body.words.length, 2);
    const direct = r.body;
    r = await call("GET", "/api/vocab/last", null, session);
    assert.equal(r.body.status, "done"); assert.equal(r.body.jobId, "test-job-0001");
    assert.deepStrictEqual(r.body.words, direct.words, "the same words"); assert.deepStrictEqual(r.body.quota, direct.quota);
    r = await call("POST", "/api/vocab/ack", { jobId: "some-other-job" }, session); assert.equal(r.body.removed, false, "only the right job is removed");
    assert.equal((await call("GET", "/api/vocab/last", null, session)).body.status, "done");
    r = await call("POST", "/api/vocab/ack", { jobId: "test-job-0001" }, session); assert.equal(r.body.removed, true);
    assert.deepStrictEqual((await call("GET", "/api/vocab/last", null, session)).body, { status: "none" }, "confirmed: nothing is held any more");
    assert.equal(cols.jobs.docs.length, 0);

    // a request whose connection is cut while Gemini is still working (this is what closing the popup does)
    const quotaBefore = cols.users.docs[0].daily_quota;
    const ac = new AbortController();
    const cut = fetch(base + "/api/vocab", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", authorization: "Bearer " + session },
      body: JSON.stringify({ title: "SLOW", text: fillers + " ephemeral plausible", wordLimit: 2, jobId: "test-job-0002" }) }).then(() => "answered", () => "cancelled");
    for (let i = 0; i < 100; i++) { r = await call("GET", "/api/vocab/last", null, session); if (r.body.status === "running") break; await sleep(10); }
    assert.equal(r.body.status, "running", "the server is working on it"); assert.equal(r.body.jobId, "test-job-0002");
    // a second request while the first still runs is refused and costs nothing
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " lucid", wordLimit: 1, jobId: "test-job-0003" }, session);
    assert.equal(r.status, 409); assert.equal(r.body.code, "IN_PROGRESS"); assert.equal(r.body.jobId, "test-job-0002");
    assert.equal(cols.users.docs[0].daily_quota, quotaBefore - 2, "only the first request was charged");
    ac.abort(); assert.equal(await cut, "cancelled", "the popup's connection is gone");
    let got; for (let i = 0; i < 100; i++) { got = (await call("GET", "/api/vocab/last", null, session)).body; if (got.status !== "running") break; await sleep(20); }
    assert.equal(got.status, "done", "the server finished although nobody was waiting"); assert.equal(got.jobId, "test-job-0002");
    assert.deepStrictEqual(got.words.map((w) => w.word).sort(), ["ephemeral", "plausible"]);
    assert.equal(got.quota.remainingToday, quotaBefore - 2); assert.equal(cols.users.docs[0].daily_quota, quotaBefore - 2);
    assert.equal(countOfHistory(), hBefore + 4, "the words are in the history exactly once");
    // asking again gives the same words (nothing is generated or charged twice), until they are confirmed
    assert.deepStrictEqual((await call("GET", "/api/vocab/last", null, session)).body.words, got.words);
    assert.equal(cols.users.docs[0].daily_quota, quotaBefore - 2);
    await call("POST", "/api/vocab/ack", { jobId: "test-job-0002" }, session);

    // a failure while the popup was closed: the message is kept, the words are refunded, and the next request is not blocked
    process.env.GEMINI_API_KEY = "badkey";
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " lucid", wordLimit: 3, jobId: "test-job-0004" }, session); assert.equal(r.status, 502);
    process.env.GEMINI_API_KEY = "goodkey";
    r = await call("GET", "/api/vocab/last", null, session);
    assert.equal(r.body.status, "failed"); assert.equal(r.body.jobId, "test-job-0004"); assert.match(r.body.error, /rejected the API key/);
    assert.equal(cols.users.docs[0].daily_quota, quotaBefore - 2, "refunded");
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " rhetoric", wordLimit: 1, jobId: "test-job-0005" }, session);
    assert.equal(r.status, 200, "a failed request does not block the next one"); assert.equal(r.body.jobId, "test-job-0005");
    await call("POST", "/api/vocab/ack", { jobId: "test-job-0005" }, session);

    // a refused request (not enough quota) leaves nothing behind; a request without a usable id gets one from the server
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 13, jobId: "test-job-0006" }, session); assert.equal(r.status, 429);
    assert.equal(cols.jobs.docs.length, 0, "nothing to collect after a refusal");
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " volatile", wordLimit: 1, jobId: "bad id!" }, session);
    assert.equal(r.status, 200); assert.match(r.body.jobId, /^[0-9a-f-]{36}$/, "the server names it");
    await call("POST", "/api/vocab/ack", { jobId: r.body.jobId }, session);

    // old results disappear: after an hour (also before MongoDB's cleanup runs), and a request that has been "running" for too long is dead
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " culpable", wordLimit: 1, jobId: "test-job-0007" }, session); assert.equal(r.status, 200);
    cols.jobs.docs[0].expires_at = new Date(Date.now() - 1000);
    assert.deepStrictEqual((await call("GET", "/api/vocab/last", null, session)).body, { status: "none" }, "expired result is not returned");
    cols.jobs.docs[0].expires_at = new Date(Date.now() + 3600000); cols.jobs.docs[0].status = "running"; cols.jobs.docs[0].started = new Date(Date.now() - 6 * 60000);
    r = await call("GET", "/api/vocab/last", null, session); assert.equal(r.body.status, "failed"); assert.match(r.body.error, /did not finish/);
    r = await call("POST", "/api/vocab", { title: "T", text: fillers + " mitigate", wordLimit: 1, jobId: "test-job-0008" }, session);
    assert.notEqual(r.status, 409, "a dead request does not block the user for ever");
    await call("POST", "/api/vocab/ack", { jobId: "test-job-0008" }, session);
    assert.equal(cols.users.docs[0].daily_quota >= 0, true);

    // --- the last trial day (signup + 4) is still the full plan ---
    today = "2026-10-23";
    r = await call("GET", "/auth/me", null, session); assert.equal(r.body.account.active, true);
    r = await call("GET", "/api/history", null, session); assert.equal(r.status, 200, "history download works on the last trial day");

    // --- the trial ends on expiry_date: the Free plan (same quota; the popup shows 3 words; no history download) ---
    today = "2026-10-24"; // = expiry_date
    r = await call("GET", "/auth/me", null, session); assert.equal(r.body.account.active, false); assert.equal(r.body.account.freeWords, 3);
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 5 }, session);
    assert.equal(r.status, 200, "an expired account can still generate"); assert.equal(r.body.free, true);
    assert.ok(r.body.words.length >= 1, "the Free plan is not capped at 3 on the server: the popup shows 3 and locks the rest");
    assert.equal(r.body.quota.remainingToday, 13 - r.body.words.length, "same daily quota of 13: every word returned is charged");
    r = await call("GET", "/api/history", null, session); assert.equal(r.status, 403); assert.equal(r.body.code, "PLAN_EXPIRED");

    // --- premium: 21 days counting today ---
    r = await call("POST", "/admin/premium", { email: "alice@gmail.com" }); assert.equal(r.status, 401, "admin key required");
    r = await call("POST", "/admin/premium", { email: "alice@gmail.com" }, null, { "x-admin-key": "wrong" }); assert.equal(r.status, 401);
    r = await call("POST", "/admin/premium", { email: "nobody@gmail.com" }, null, { "x-admin-key": "adm1n" }); assert.equal(r.status, 404);
    r = await call("POST", "/admin/premium", { email: "Alice@gmail.com" }, null, { "x-admin-key": "adm1n" });
    assert.equal(r.status, 200); assert.equal(r.body.account.validUntil, addDays(today, 20), "21 days including today");
    r = await call("GET", "/api/history", null, session); assert.equal(r.status, 200, "history download is unlocked by premium");
    r = await call("POST", "/api/vocab", { ...article, wordLimit: 1 }, session); assert.equal(r.status, 200, "premium user can generate again");

    // --- removed account ---
    cols.users.docs.length = 0;
    r = await call("GET", "/auth/me", null, session); assert.equal(r.status, 401, "session of a removed account");
    console.log("All backend tests passed.");
  } catch (e) { console.error("FAILED:", e.stack || e.message); process.exitCode = 1; }
  finally { server.close(); mockGoogle.close(); gem.kill(); try { fs.unlinkSync(mockLog); } catch (e) {} }
})();
