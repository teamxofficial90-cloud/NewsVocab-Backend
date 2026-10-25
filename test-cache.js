// The article cache. Mock Google (one email per token) and mock Gemini (300 ms per answer, every request logged), in-memory database.
// Run: node test-cache.js
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path");
const { spawn } = require("child_process"); const assert = require("assert");
const { createGate } = require("./gate"); const { articleHash, mergeWords } = require("./article-key"); const { stem } = require("./validate");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POOL = ("draconian stringent ambiguous contentious intransigent exacerbated conciliatory stalled gridlock ensuing pragmatic mounting scrutiny rhetoric volatile culpable mitigate bolster curtail precarious " +
  "resilient unprecedented advocate scrupulous tenuous impetus repercussions formidable dwindling salient ostensibly burgeoning plausible ephemeral staunch lucid arduous discord vindicate cogent").split(" ");
const article = (tag, words = POOL) => Array.from({ length: 150 }, (_, i) => "filler" + tag + i).join(" ") + " " + words.join(" ");

(async () => {
  // ---- helpers that need no server ----
  assert.equal(articleHash("The Minister said: \"No!\"\n\n  Really."), articleHash("the minister said no really"), "spacing, case and punctuation do not change the key");
  assert.notEqual(articleHash("one two three"), articleHash("one two four"));
  const merged = mergeWords([{ word: "advocate" }, { word: "bolster" }], [{ word: "advocated" }, { word: "curtail" }, { word: "bolster" }], stem, 3);
  assert.deepEqual(merged.words.map((w) => w.word), ["advocate", "bolster", "curtail"]); assert.equal(merged.added, 1, "another form of a word is not added; the cap is respected");
  console.log("  article-key unit tests passed");

  const CLIENT = "test-client.apps.googleusercontent.com";
  const mockGoogle = http.createServer((req, res) => {
    const n = new URL(req.url, "http://x").searchParams.get("id_token").replace(/^x+/, "");
    res.writeHead(200, { "content-type": "application/json", connection: "close" }); // no idle keep-alive sockets for the client to trip over
    res.end(JSON.stringify({ aud: CLIENT, iss: "https://accounts.google.com", exp: String(Math.floor(Date.now() / 1000) + 3600), email_verified: "true", sub: n, email: n + "@gmail.com" }));
  });
  await new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r));
  const mockLog = path.join(os.tmpdir(), "nv-cache-" + Date.now() + ".jsonl");
  const geminiPort = 19700 + Math.floor(Math.random() * 90);
  const gem = spawn("node", [path.join(__dirname, "..", "scripts", "mock-gemini.js")], { env: { ...process.env, MOCK_PORT: String(geminiPort), MOCK_LOG: mockLog, MOCK_DELAY_MS: "300" }, stdio: "ignore" });
  Object.assign(process.env, { PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port,
    GEMINI_API_KEY: "goodkey", GEMINI_BASE_URL: "http://127.0.0.1:" + geminiPort, GEMINI_RETRY_BASE_MS: "20", ARTICLE_CACHE_DAYS: "2" });
  delete process.env.ARTICLE_CACHE; // the cache is ON (the default)
  const { start } = require("./server"); const { createMemoryCollections } = require("./memory-db");
  const cols = createMemoryCollections(); let day = "2026-10-21";
  let server = await start(cols, { today: () => day });
  const baseOf = (s) => "http://127.0.0.1:" + s.address().port; let base = baseOf(server);
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const login = async (name) => { // a long plan, so the test can move through several days
    const t = (await call("POST", "/auth/google", { idToken: "x".repeat(20) + name })).body.token;
    cols.users.docs.find((u) => u.email === name + "@gmail.com").expiry_date = "2030-01-01"; return t;
  };
  const lines = () => fs.readFileSync(mockLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const calls = () => lines().length;
  const post = (tok, text, limit, extra = {}) => call("POST", "/api/vocab", { title: "T", text, wordLimit: limit, ...extra }, tok);
  const names = (r) => r.body.words.map((w) => w.word);
  const health = async () => (await call("GET", "/health")).body.articleCache;
  const cacheDoc = (text) => cols.articles.docs.find((d) => d.h === articleHash(text.slice(0, 10000)));

  try {
    for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:" + geminiPort); break; } catch (e) { await sleep(100); } }
    const A = article("a");

    // 1. First user of an article: one Gemini call asking for 30 candidates (no brackets: no user data), words saved for everybody.
    const alice = await login("alice"), bob = await login("bob");
    let r = await post(alice, A, 5);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(names(r), POOL.slice(0, 5));
    assert.equal(calls(), 1); assert.equal(lines()[0].candidateCount, 30); assert.ok(!lines()[0].article.includes("["), "the article goes to Gemini unmarked");
    let doc = cacheDoc(A);
    assert.equal(cols.articles.docs.length, 1); assert.equal(doc.words.length, 30);
    assert.equal(new Date(doc.expires_at) - new Date(doc.created), 2 * 24 * 3600 * 1000, "kept for 2 days");
    assert.ok(!JSON.stringify(doc).includes("filler"), "no article text is stored");

    // 2. Second user, same article: no Gemini call, same first words.
    r = await post(bob, A, 5);
    assert.equal(r.status, 200); assert.deepEqual(names(r), POOL.slice(0, 5)); assert.equal(calls(), 1, "served from the cache");
    assert.equal(r.body.quota.remainingToday, 8, "quota and history work as before"); assert.equal(r.body.quota.historyCount, 5);
    let h = await health(); assert.equal(h.enabled, true); assert.equal(h.hits, 1); assert.equal(h.misses, 1);

    // 3. A user's history is respected: alice already has the first 5, so she gets the next 5.
    day = "2026-10-22";
    r = await post(alice, A, 5); assert.equal(r.status, 200); assert.deepEqual(names(r), POOL.slice(5, 10)); assert.equal(calls(), 1);

    // 4. The same article formatted differently (spacing, commas) is the same article; a different article is not.
    const A2 = A.split(" ").map((w, i) => (i % 20 === 19 ? w + "," : w)).join("\n\n");
    r = await post(bob, A2, 5); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(names(r), POOL.slice(5, 10)); assert.equal(calls(), 1, "reformatted copy: still a hit");
    r = await post(bob, article("b"), 5); assert.equal(r.status, 200); assert.equal(calls(), 2, "another article: a new Gemini call"); assert.equal(cols.articles.docs.length, 2);

    // 5. Twenty users open the same NEW article at the same moment: one Gemini call, the rest wait for it and are told how long.
    const C = article("c"); const crowd = await Promise.all(Array.from({ length: 20 }, (_, i) => login("crowd" + i)));
    const before = await health(); const callsBefore = calls();
    const posts = crowd.map((tok, i) => post(tok, C, 4, { jobId: "job-crowd" + i + "-aaaaaaaa" }));
    await sleep(120);
    const st = await Promise.all(crowd.map((tok, i) => call("GET", "/api/vocab/queue?jobId=job-crowd" + i + "-aaaaaaaa", null, tok).then((x) => x.body)));
    assert.ok(st.every((x) => x.state === "running" && x.etaSeconds > 0), "waiting users get the countdown too: " + JSON.stringify(st.slice(0, 3)));
    const results = await Promise.all(posts);
    assert.ok(results.every((x) => x.status === 200 && x.body.words.length === 4), "everybody got their words");
    assert.equal(calls() - callsBefore, 1, "ONE Gemini call for 20 users");
    h = await health(); assert.equal(h.misses - before.misses, 1); assert.equal((h.waited - before.waited) + (h.hits - before.hits), 19);

    // 6. A user whose history leaves too few cached words gets one normal per-user call, and the new words join the cache.
    const frank = await login("frank");
    for (const d of ["2026-10-23", "2026-10-24"]) { day = d; r = await post(frank, A, 13); assert.equal(r.status, 200); assert.equal(r.body.words.length, 13); }
    assert.equal(calls(), callsBefore + 1 + 0, "two full requests served from the cache");
    const callsMid = calls(); day = "2026-10-25";
    r = await post(frank, A, 13); // only 4 of the 30 cached words are left for frank
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.words.length, 13);
    assert.equal(calls(), callsMid + 1, "one extra Gemini call, for frank only");
    assert.ok(lines()[calls() - 1].article.includes("[draconian]"), "that call is the normal one: his history words are marked");
    const hist = new Set(POOL.slice(0, 26)); assert.ok(names(r).every((w) => !hist.has(w)), "no repeated word");
    assert.deepEqual(names(r), POOL.slice(26, 39));
    assert.equal(cacheDoc(A).words.length, 39, "the words it found were added to the cache (30 + 9 new)");
    h = await health(); assert.equal(h.fallbacks, 1);
    const gary = await login("gary"); r = await post(gary, A, 13); assert.equal(calls(), callsMid + 1, "a new user is still served from the cache");
    assert.deepEqual(names(r), POOL.slice(0, 13));

    // 7. An article with only 10 good words: not enough for 13, but the history did not cause that, so no extra call is made.
    const F = article("few", POOL.slice(0, 10)); const gina = await login("gina"), hank = await login("hank");
    const c7 = calls();
    r = await post(gina, F, 13); assert.equal(r.status, 200); assert.equal(r.body.words.length, 10); assert.match(r.body.warning, /10 important words are found/); assert.equal(r.body.quota.remainingToday, 3);
    assert.equal(calls(), c7 + 1);
    r = await post(hank, F, 13); assert.equal(r.body.words.length, 10); assert.equal(calls(), c7 + 1, "second user: from the cache, no call");
    day = "2026-10-26"; // gina has now learned all 10: nothing new is left. That is the normal path's answer, as without a cache.
    r = await post(gina, F, 13); assert.equal(r.status, 502); assert.match(r.body.error, /No new words/); assert.equal(calls(), c7 + 2);
    assert.equal((await post(gina, F, 1)).status, 502, "refunded: the quota is not used up");

    // 8. The first request fails (Gemini keeps saying 429): everyone waiting gets the error and their words back, nothing is cached,
    //     and the next request for that article starts fresh.
    const E = article("e"); const docsBefore = cols.articles.docs.length;
    const vics = await Promise.all(Array.from({ length: 5 }, (_, i) => login("vic" + i)));
    const failing = await Promise.all(vics.map((tok) => call("POST", "/api/vocab", { title: "ALWAYS429", text: E, wordLimit: 3 }, tok)));
    assert.ok(failing.every((x) => x.status === 502 && /rate-limited/.test(x.body.error)), JSON.stringify(failing.map((x) => x.status)));
    assert.equal(cols.articles.docs.length, docsBefore, "a failed call caches nothing");
    r = await post(vics[0], E, 1); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.quota.remainingToday, 12, "the failed request was refunded");
    assert.equal(cols.articles.docs.length, docsBefore + 1);

    // 9. An expired entry (MongoDB's cleanup is slow) is ignored and replaced, not served and not duplicated.
    cacheDoc(A).expires_at = new Date(Date.now() - 1000); const c11 = calls(); const walt = await login("walt");
    r = await post(walt, A, 5); assert.equal(r.status, 200); assert.equal(calls(), c11 + 1, "treated as a miss");
    assert.equal(cols.articles.docs.filter((d) => d.h === articleHash(A)).length, 1); assert.ok(new Date(cacheDoc(A).expires_at) > new Date()); assert.equal(cacheDoc(A).words.length, 30);

    // 10. The line to Gemini is full: a cached article (and one being fetched right now) still gets through, a new one is turned away.
    await new Promise((res) => server.close(res)); server.closeAllConnections && server.closeAllConnections();
    server = await start(cols, { today: () => day, gate: createGate({ concurrency: 1, queueSize: 0, maxWaitMs: 5000, initialAvgMs: 600 }) }); base = baseOf(server);
    const [ava, yan, zed, zoe, zack] = await Promise.all(["ava", "yan", "zed", "zoe", "zack"].map(login));
    assert.equal((await post(ava, C, 2)).status, 200, "this server has not seen article C yet: a hit, the line is empty");
    const G = article("g"), H = article("h");
    const slow = call("POST", "/api/vocab", { title: "SLOW", text: H, wordLimit: 2 }, yan); // takes the only slot for 600 ms
    await sleep(150);
    const t0 = Date.now(); const rZed = await post(zed, C, 2); const tZed = Date.now() - t0;
    assert.equal(rZed.status, 200, "cached article passes a full line"); assert.ok(tZed < 250, "and is answered at once (" + tZed + " ms)");
    const rZoe = await post(zoe, G, 2); assert.equal(rZoe.status, 503); assert.equal(rZoe.body.error, "Sorry, try again"); assert.equal(rZoe.body.code, "QUEUE_FULL");
    const rZack = await post(zack, H, 2); assert.equal(rZack.status, 200, "an article being fetched right now is waited for, not turned away: " + JSON.stringify(rZack.body));
    assert.equal((await slow).status, 200);
    console.log("Cache tests passed.");
  } catch (e) { console.error("FAILED:", e.stack || e.message); process.exitCode = 1; }
  finally { try { server.close(); } catch (e) {} mockGoogle.close(); gem.kill(); for (const f of [mockLog]) try { fs.unlinkSync(f); } catch (e) {} }
})();
