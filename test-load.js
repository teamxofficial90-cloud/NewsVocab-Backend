// Load test with the REAL limits (30 running + 100 waiting): 200 different users press Generate at the same instant.
// Gemini is a fake that takes 2 s per answer and counts how many calls run at once. Database is the in-memory stand-in.
// Checks who is served and who is turned away, that Gemini never sees more than 30 calls at once, and how close the countdown
// estimates were to the real waiting time. Run: node test-load.js
const http = require("http"); const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = "test-client.apps.googleusercontent.com";
const POOL = ("draconian stringent ambiguous contentious intransigent exacerbated conciliatory stalled gridlock ensuing pragmatic mounting scrutiny rhetoric volatile culpable mitigate bolster curtail precarious " +
  "resilient unprecedented advocate scrupulous tenuous impetus repercussions formidable dwindling salient ostensibly burgeoning plausible ephemeral staunch lucid arduous discord vindicate cogent").split(" ");
const TEXT = Array.from({ length: 150 }, (_, i) => "filler" + i).join(" ") + " " + POOL.join(" ");
const GEMINI_MS = 2000, USERS = 200, CONC = 30, QUEUE = 100;

let inFlight = 0, maxInFlight = 0, geminiCalls = 0;
const mockGemini = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    geminiCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const words = POOL.map((w) => [w, "adjective", "Meaning of " + w + " in this article.", "Plain meaning of " + w + ".", "The editor found it " + w + " yesterday.", ["similar" + w, "akin" + w], ["opposite" + w]]);
    setTimeout(() => { inFlight--; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ words }) }] } }] })); }, GEMINI_MS);
  });
});
const mockGoogle = http.createServer((req, res) => {
  const n = new URL(req.url, "http://x").searchParams.get("id_token").replace(/^x+/, "");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ aud: CLIENT, iss: "https://accounts.google.com", exp: String(Math.floor(Date.now() / 1000) + 3600), email_verified: "true", sub: n, email: n + "@gmail.com" }));
});

(async () => {
  await Promise.all([new Promise((r) => mockGemini.listen(0, "127.0.0.1", r)), new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r))]);
  Object.assign(process.env, { ARTICLE_CACHE: "off" /* 200 users send the same article: test the queue alone, not the cache */, PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", GEMINI_API_KEY: "k",
    GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port, GEMINI_BASE_URL: "http://127.0.0.1:" + mockGemini.address().port,
    GEMINI_CONCURRENCY: String(CONC), QUEUE_SIZE: String(QUEUE), GEMINI_EST_SECONDS: "10" }); // a deliberately wrong first guess (real: 2 s)
  const { start } = require("./server"); const { createMemoryCollections } = require("./memory-db");
  let server = await start(createMemoryCollections(), { today: () => "2026-10-21" });
  let base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let maxLag = 0, last = Date.now(); const lagTimer = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 50); last = n; }, 50);

  async function burst(label, tag) {
    const tokens = await Promise.all(Array.from({ length: USERS }, (_, i) => call("POST", "/auth/google", { idToken: "x".repeat(20) + tag + i }).then((r) => r.body.token)));
    const jobIds = tokens.map((_, i) => "job-" + tag + i + "-aaaaaaaa");
    const t0 = Date.now(); const finished = new Array(USERS);
    const posts = tokens.map((tok, i) => call("POST", "/api/vocab", { title: "T", text: TEXT, wordLimit: 1, jobId: jobIds[i] }, tok).then((r) => { finished[i] = Date.now() - t0; return r; }));
    await sleep(500); // everybody has been admitted or turned away by now
    const tAsk = Date.now() - t0;
    const st = await Promise.all(tokens.map((tok, i) => call("GET", "/api/vocab/queue?jobId=" + jobIds[i], null, tok).then((r) => r.body)));
    const results = await Promise.all(posts);
    const ok = results.map((r, i) => ({ r, i })).filter((o) => o.r.status === 200), no = results.filter((r) => r.status === 503);
    // the estimate each served user was given at ~0.5 s against what really remained
    const rows = ok.map((o) => ({ state: st[o.i].state, pos: st[o.i].position, pred: st[o.i].etaSeconds, actual: (finished[o.i] - tAsk) / 1000 })).filter((x) => x.state !== "none");
    const bucket = (lo, hi) => { const g = rows.filter((x) => x.pos >= lo && x.pos <= hi); return g.length ? g : null; };
    console.log("\n" + label + ": served " + ok.length + ", turned away " + no.length + ", everyone answered in " + (Math.max(...finished) / 1000).toFixed(1) + " s");
    console.log("  estimate given at 0.5 s vs seconds that really remained (mean over the group):");
    for (const [name, lo, hi] of [["running now", 0, 0], ["place 1-30", 1, 30], ["place 31-60", 31, 60], ["place 61-90", 61, 90], ["place 91-100", 91, 100]]) {
      const g = bucket(lo, hi); if (!g) continue;
      const mean = (f) => g.reduce((s, x) => s + f(x), 0) / g.length;
      console.log("    " + name.padEnd(13) + " n=" + String(g.length).padStart(3) + "  told " + mean((x) => x.pred).toFixed(1).padStart(5) + " s   real " + mean((x) => x.actual).toFixed(1).padStart(5) + " s");
    }
    return { ok, no, rows, finished, results };
  }

  try {
    // Burst 1: 200 at once. The first estimate guess (10 s per call) is wrong on purpose.
    const b1 = await burst("Burst 1 (first guess 10 s per call, real 2 s)", "a");
    assert.equal(b1.ok.length, CONC + QUEUE, "30 running + 100 waiting are served");
    assert.equal(b1.no.length, USERS - CONC - QUEUE, "the other 70 are turned away");
    assert.ok(b1.no.every((r) => r.body.code === "QUEUE_FULL" && r.body.error === "Sorry, try again"));
    assert.ok(maxInFlight <= CONC, "Gemini never saw more than " + CONC + " calls at once (saw " + maxInFlight + ")");
    assert.equal(geminiCalls, CONC + QUEUE, "no Gemini call was wasted on the turned-away users");
    const waves = Math.max(...b1.finished) / 1000; assert.ok(waves >= 4 * 2 && waves < 8 * 2, "130 users in 30s = 5 rounds of 2 s: " + waves);
    // Burst 2: the server has now seen 130 real calls, so its estimate has adapted.
    const b2 = await burst("Burst 2 (after the server learned the real speed)", "b");
    assert.equal(b2.ok.length, CONC + QUEUE); assert.equal(b2.no.length, USERS - CONC - QUEUE);
    const late = b2.rows.filter((x) => x.actual > x.pred + 1).length, mae = b2.rows.reduce((s, x) => s + Math.abs(x.pred - x.actual), 0) / b2.rows.length;
    console.log("  estimate error after learning: mean " + mae.toFixed(1) + " s; users whose real wait was more than 1 s longer than told: " + late + " of " + b2.rows.length);
    assert.ok(late === 0, "the countdown should not end before the work does (late: " + late + ")");
    // Burst 3: the article cache ON (the default). 200 users open the SAME new article at the same instant: one Gemini call for all
    // of them, nobody is turned away, and everybody is answered in about the time of that one call.
    await new Promise((r) => server.close(r)); server.closeAllConnections && server.closeAllConnections();
    delete process.env.ARTICLE_CACHE;
    server = await start(createMemoryCollections(), { today: () => "2026-10-21" }); base = "http://127.0.0.1:" + server.address().port;
    const callsBefore = geminiCalls;
    const b3 = await burst("Burst 3 (article cache ON, all 200 users open the same new article)", "c");
    assert.equal(b3.ok.length, USERS, "everybody is served"); assert.equal(b3.no.length, 0, "nobody is turned away");
    assert.equal(geminiCalls - callsBefore, 1, "ONE Gemini call for 200 users");
    assert.ok(Math.max(...b3.finished) < GEMINI_MS + 1500, "answered in about one call's time: " + Math.max(...b3.finished));
    console.log("  Gemini calls for these 200 users: " + (geminiCalls - callsBefore));
    console.log("\nGemini calls in total: " + geminiCalls + ", most at once: " + maxInFlight + ", worst event-loop stall: " + maxLag + " ms, memory: " + Math.round(process.memoryUsage().rss / 1048576) + " MB");
    console.log("Load test passed.");
  } catch (e) { console.error("FAILED:", e.stack || e.message); process.exitCode = 1; }
  finally { clearInterval(lagTimer); server.close(); mockGemini.close(); mockGoogle.close(); }
})();
