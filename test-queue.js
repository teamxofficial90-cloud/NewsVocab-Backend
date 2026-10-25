// The Gemini queue: concurrency limit, a line of QUEUE_SIZE, "Sorry, try again" when it is full, countdown estimates,
// retry on 429, timeout. Uses mock Google (one email per token) and mock Gemini (500 ms per answer). Run: node test-queue.js
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path");
const { spawn } = require("child_process"); const assert = require("assert");
const { createGate } = require("./gate");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gateUnitTests() {
  // ETA: with a fake clock, position p waits p * avg / concurrency and then runs once (x1.15 margin, rounded up).
  let t = 0; const gate = createGate({ concurrency: 2, queueSize: 3, maxWaitMs: 100000, initialAvgMs: 10000, now: () => t });
  const release = []; const job = () => new Promise((r) => release.push(r));
  const ps = ["a", "b", "c", "d", "e"].map((k) => gate.run(job, k).catch((e) => e));
  assert.equal(gate.isFull(), true, "2 running + 3 waiting = full");
  assert.equal((await gate.run(job, "f").catch((e) => e)).code, "QUEUE_FULL");
  assert.deepEqual(["a", "b", "c", "d", "e"].map((k) => gate.status(k).state), ["running", "running", "waiting", "waiting", "waiting"]);
  assert.deepEqual(["c", "d", "e"].map((k) => gate.status(k).position), [1, 2, 3]);
  assert.equal(gate.status("c").etaSeconds, Math.ceil((1 * 10 / 2 + 10) * 1.15));
  assert.equal(gate.status("e").etaSeconds, Math.ceil((3 * 10 / 2 + 10) * 1.15));
  t = 4000; assert.equal(gate.status("a").etaSeconds, Math.ceil(6 * 1.15), "a running job counts down");
  release[0](); await sleep(5); // a finishes (took 4 s), c moves up into the free slot, d and e move forward
  assert.equal(gate.status("c").state, "running"); assert.equal(gate.status("d").position, 1);
  assert.ok(Math.abs(gate.stats().avgSeconds - (0.8 * 10 + 0.2 * 4)) < 1e-9, "average follows the real duration");
  assert.equal(gate.status("a").state, "none");
  release.slice(1).forEach((r) => r()); for (let i = 0; i < 6; i++) { await sleep(5); release.forEach((r) => r()); }
  await Promise.all(ps); assert.deepEqual(gate.stats().active, 0);
  // A request that waits longer than maxWaitMs is turned away; the running one is not affected.
  const g2 = createGate({ concurrency: 1, queueSize: 2, maxWaitMs: 100 });
  const first = g2.run(() => sleep(300).then(() => "ok"), "x"); const second = await g2.run(() => "never", "y").catch((e) => e);
  assert.equal(second.code, "QUEUE_TIMEOUT"); assert.equal(await first, "ok"); assert.equal(g2.status("y").state, "none");
  // A failing job frees its slot.
  const g3 = createGate({ concurrency: 1, queueSize: 1 });
  await g3.run(() => { throw new Error("boom"); }).catch(() => {}); assert.equal(await g3.run(() => 7), 7);
  console.log("  gate unit tests passed");
}

(async () => {
  await gateUnitTests();
  const CLIENT = "test-client.apps.googleusercontent.com";
  const mockGoogle = http.createServer((req, res) => {
    const tok = new URL(req.url, "http://x").searchParams.get("id_token"); const n = tok.replace(/^x+/, "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ aud: CLIENT, iss: "https://accounts.google.com", exp: String(Math.floor(Date.now() / 1000) + 3600), email_verified: "true", sub: n, email: n + "@gmail.com" }));
  });
  await new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r));
  const mockLog = path.join(os.tmpdir(), "nv-queue-" + Date.now() + ".jsonl");
  const geminiPort = 19900 + Math.floor(Math.random() * 90);
  const gem = spawn("node", [path.join(__dirname, "..", "scripts", "mock-gemini.js")], { env: { ...process.env, MOCK_PORT: String(geminiPort), MOCK_LOG: mockLog, MOCK_DELAY_MS: "500" }, stdio: "ignore" });
  Object.assign(process.env, { ARTICLE_CACHE: "off" /* every user sends the same article here: test the queue alone, not the cache */, PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port,
    GEMINI_API_KEY: "goodkey", GEMINI_BASE_URL: "http://127.0.0.1:" + geminiPort,
    GEMINI_CONCURRENCY: "2", QUEUE_SIZE: "3", GEMINI_EST_SECONDS: "4", GEMINI_TIMEOUT_MS: "1500", GEMINI_MAX_RETRIES: "2", GEMINI_RETRY_BASE_MS: "20" });
  const { start } = require("./server"); const { createMemoryCollections } = require("./memory-db");
  const cols = createMemoryCollections();
  const server = await start(cols, { today: () => "2026-10-21" });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const text = Array.from({ length: 150 }, (_, i) => "filler" + i).join(" ") + " draconian stringent ambiguous contentious intransigent exacerbated conciliatory stalled gridlock ensuing pragmatic mounting scrutiny rhetoric volatile culpable mitigate bolster curtail precarious resilient unprecedented advocate scrupulous tenuous impetus repercussions formidable dwindling salient ostensibly burgeoning plausible ephemeral staunch lucid arduous discord vindicate cogent";
  const login = async (name) => (await call("POST", "/auth/google", { idToken: "x".repeat(20) + name })).body.token;

  try {
    for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:" + geminiPort); break; } catch (e) { await sleep(100); } }
    const N = 8; const names = Array.from({ length: N }, (_, i) => "user" + i);
    const sessions = await Promise.all(names.map(login));
    const jobIds = names.map((n) => "job-" + n + "-aaaaaaaa");

    // 1. Eight users at the same moment, room for 2 running + 3 waiting: five are served, three get "Sorry, try again".
    const started = Date.now(); const done = [];
    const posts = sessions.map((s, i) => call("POST", "/api/vocab", { title: "T", text, wordLimit: 1, jobId: jobIds[i] }, s).then((r) => { done[i] = Date.now() - started; return r; }));
    await sleep(200);

    // 2. While they wait, the popup can ask for its estimate: 2 running, 3 waiting at positions 1..3 with growing estimates, 3 turned away.
    const st = await Promise.all(sessions.map((s, i) => call("GET", "/api/vocab/queue?jobId=" + jobIds[i], null, s)));
    const states = st.map((x) => x.body);
    assert.equal(states.filter((x) => x.state === "running").length, 2, JSON.stringify(states));
    const waiting = states.map((x, i) => ({ ...x, i })).filter((x) => x.state === "waiting").sort((a, b) => a.position - b.position);
    assert.deepEqual(waiting.map((w) => w.position), [1, 2, 3], JSON.stringify(states));
    assert.ok(waiting[0].etaSeconds < waiting[1].etaSeconds && waiting[1].etaSeconds < waiting[2].etaSeconds, "later in line = longer estimate");
    assert.ok(waiting.every((w) => Number.isInteger(w.etaSeconds) && w.etaSeconds > 0));
    assert.equal(states.filter((x) => x.state === "none").length, 3, "the three turned away have no ticket");

    // 3. The line is still full, so a ninth user is turned away immediately, before any database work (no job is created).
    const late = await login("late");
    let r = await call("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, late);
    assert.equal(r.status, 503); assert.equal(r.body.code, "QUEUE_FULL"); assert.equal(r.body.error, "Sorry, try again");
    assert.equal((await call("GET", "/api/vocab/last", null, late)).body.status, "none", "no job was created");

    // 4. Someone else's job id shows nothing (the ticket is tied to the logged-in user).
    assert.equal((await call("GET", "/api/vocab/queue?jobId=" + jobIds[waiting[0].i], null, late)).body.state, "none");
    assert.equal((await call("GET", "/api/vocab/queue?jobId=%00bad", null, late)).body.state, "none");
    assert.equal((await call("GET", "/api/vocab/queue?jobId=" + jobIds[0])).status, 401, "needs a login");

    const results = await Promise.all(posts);
    const ok = results.filter((x) => x.status === 200), rejected = results.filter((x) => x.status === 503);
    assert.equal(ok.length, 5, results.map((x) => x.status).join()); assert.equal(rejected.length, 3);
    assert.ok(rejected.every((x) => x.body.error === "Sorry, try again" && x.body.code === "QUEUE_FULL"));
    // First come, first served: the one at position 3 finished after the ones at positions 1 and 2.
    assert.ok(done[waiting[2].i] > done[waiting[0].i] && done[waiting[2].i] > done[waiting[1].i], "line is first-in-first-out: " + done.join());
    assert.ok(done[waiting[2].i] >= 1400, "three rounds of 500 ms for the last one: " + done[waiting[2].i]);

    // 5. A turned-away user lost nothing: no quota used (13 - 1 = 12 left after one word), no job left behind, and can retry now.
    const rej = results.map((x, i) => ({ x, i })).filter((o) => o.x.status === 503).map((o) => o.i);
    assert.equal((await call("GET", "/api/vocab/last", null, sessions[rej[0]])).body.status, "none");
    r = await call("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, sessions[rej[0]]);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.quota.remainingToday, 12, "the rejected request was not charged");
    assert.equal((await call("GET", "/api/vocab/queue?jobId=" + r.body.jobId, null, sessions[rej[0]])).body.state, "none", "ticket removed when finished");

    // 6. Gemini answers 429 twice, then works: the user just waits a little longer and gets the words.
    const flaky = await login("flaky");
    r = await call("POST", "/api/vocab", { title: "FLAKY", text, wordLimit: 1 }, flaky);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.words.length, 1);

    // 7. Gemini hangs: cancelled after GEMINI_TIMEOUT_MS, the user is told, and the words are refunded.
    const hang = await login("hang"); const t0 = Date.now();
    r = await call("POST", "/api/vocab", { title: "HANG", text, wordLimit: 3 }, hang);
    assert.equal(r.status, 502); assert.match(r.body.error, /took too long/); assert.ok(Date.now() - t0 < 3500, "cut off by the timeout, not after 5 s");
    r = await call("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, hang);
    assert.equal(r.status, 200); assert.equal(r.body.quota.remainingToday, 12, "the timed-out request was refunded");

    // 8. Gemini says 429 every time: after the first try and 2 retries the user gets the "try again in a minute" message, and is refunded.
    const busy = await login("busy");
    r = await call("POST", "/api/vocab", { title: "ALWAYS429", text, wordLimit: 3 }, busy);
    assert.equal(r.status, 502); assert.match(r.body.error, /rate-limited/);
    r = await call("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, busy);
    assert.equal(r.status, 200); assert.equal(r.body.quota.remainingToday, 12, "refunded after the retries ran out");

    // 9. Waiting too long in line (a second server with a 600 ms limit, one slot, 500 ms per answer): A runs, B waits 500 ms and is
    //    served, C would wait 1000 ms and is turned away at 600 ms with "Sorry, try again", refunded, nothing left behind.
    await new Promise((res) => server.close(res)); server.closeAllConnections && server.closeAllConnections();
    const server2 = await start(createMemoryCollections(), { today: () => "2026-10-21", gate: createGate({ concurrency: 1, queueSize: 5, maxWaitMs: 600, initialAvgMs: 500 }) });
    const base2 = "http://127.0.0.1:" + server2.address().port;
    const call2 = async (method, p, body, token) => { const x = await fetch(base2 + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) }; };
    try {
      const tk = await Promise.all(["qa", "qb", "qc"].map(async (n) => (await call2("POST", "/auth/google", { idToken: "x".repeat(20) + n })).body.token));
      const t1 = Date.now();
      const out = [];
      out.push(call2("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, tk[0]));
      await sleep(60); out.push(call2("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, tk[1]));
      await sleep(60); out.push(call2("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, tk[2]));
      const [a, b2, c] = await Promise.all(out);
      assert.equal(a.status, 200); assert.equal(b2.status, 200, JSON.stringify(b2.body));
      assert.equal(c.status, 503); assert.equal(c.body.error, "Sorry, try again"); assert.equal(c.body.code, "QUEUE_FULL");
      assert.equal((await call2("GET", "/api/vocab/last", null, tk[2])).body.status, "none", "no job left behind");
      r = await call2("POST", "/api/vocab", { title: "T", text, wordLimit: 1 }, tk[2]);
      assert.equal(r.status, 200); assert.equal(r.body.quota.remainingToday, 12, "the timed-out request was refunded");
    } finally { server2.close(); }
    console.log("Queue tests passed.");
  } catch (e) { console.error("FAILED:", e.stack || e.message); process.exitCode = 1; }
  finally { try { server.close(); } catch (e) {} mockGoogle.close(); gem.kill(); try { fs.unlinkSync(mockLog); } catch (e) {} }
})();
