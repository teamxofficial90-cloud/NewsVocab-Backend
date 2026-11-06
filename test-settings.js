// Admin-editable settings test: validation, GET /config, GET/POST /admin/settings, and that a saved change really reaches the word range,
// the daily quota, the Free-plan words, the plan lengths and the Razorpay prices. Real server, in-memory collections, mock Google + Razorpay.
// Run: node test-settings.js
const http = require("http"); const crypto = require("crypto"); const assert = require("assert");
const { validate, DEFAULTS } = require("./settings");

const CLIENT = "test-client.apps.googleusercontent.com", WHSECRET = "whsec_test", KEYID = "rzp_id", KEYSECRET = "rzp_secret";
const exp = () => String(Math.floor(Date.now() / 1000) + 3600);
const tok = (email, sub) => ({ aud: CLIENT, iss: "https://accounts.google.com", exp: exp(), email_verified: "true", sub, email });
const tokens = { alice: tok("alice@gmail.com", "1"), bob: tok("bob@gmail.com", "2") };
const pad = (k) => k + "_" + "x".repeat(30);
const mockGoogle = http.createServer((req, res) => {
  const t = new URL(req.url, "http://x").searchParams.get("id_token") || ""; const claims = tokens[t.split("_")[0]];
  res.writeHead(claims ? 200 : 400, { "content-type": "application/json" }); res.end(JSON.stringify(claims || { error: "invalid_token" }));
});
let lastCreate = null;
const mockRazorpay = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    lastCreate = JSON.parse(b || "{}");
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "plink_" + Date.now(), short_url: "https://rzp.io/i/x", status: "created" }));
  });
});

const std = () => require("./settings").fresh();
const check = (name) => console.log("ok -", name);

(async () => {
  // ----- 1. validate() on its own -----
  let v = validate({}); assert(v.ok); assert.deepStrictEqual(v.settings, std()); check("an empty object gives the standard values");
  v = validate({ wordLimit: { max: "20" }, plans: { premium: { price: "19.5" } }, texts: { tagline: "  Hello  ", trialInfo: "   ", bogus: "x" }, unknown: 5 });
  assert(v.ok); assert.strictEqual(v.settings.wordLimit.max, 20); assert.strictEqual(v.settings.plans.premium.price, 19.5);
  assert.deepStrictEqual(v.settings.texts, { tagline: "Hello" }); assert(!("unknown" in v.settings));
  check("numbers sent as text are accepted; blank texts and unknown keys are dropped");
  const bad = [
    [{ wordLimit: { min: 0 } }, "wordLimit.min"], [{ wordLimit: { min: 1.5 } }, "wordLimit.min"], [{ wordLimit: { min: "abc" } }, "wordLimit.min"], [{ wordLimit: { max: 31 } }, "wordLimit.max"],
    [{ wordLimit: { min: 5, max: 4 } }, "wordLimit.max"], [{ wordLimit: { default: 0 } }, "wordLimit.default"], [{ wordLimit: { default: 14 } }, "wordLimit.default"], [{ wordLimit: { min: 5, default: 3 } }, "wordLimit.default"],
    [{ freeWords: -1 }, "freeWords"], [{ wordLimit: { max: 5, default: 5 }, freeWords: 6 }, "freeWords"], [{ plans: { trial: { price: 0 } } }, "plans.trial.price"], [{ plans: { premium: { price: 100001 } } }, "plans.premium.price"],
    [{ plans: { premium: { price: 1.234 } } }, "plans.premium.price"], [{ plans: { trial: { days: 0 } } }, "plans.trial.days"], [{ plans: { premium: { days: 3651 } } }, "plans.premium.days"], [{ plans: { trial: 5 } }, "plans.trial"], [{ wordLimit: 5 }, "wordLimit"],
    [{ texts: { tagline: "x".repeat(301) } }, "texts.tagline"], [{ texts: { tagline: 5 } }, "texts.tagline"], [{ texts: { tagline: "Hi {nope}" } }, "texts.tagline"], [{ texts: [] }, "texts"]
  ];
  for (const [input, field] of bad) { const r = validate(input); assert(!r.ok && r.errors[field], JSON.stringify(input) + " should fail on " + field + ": " + JSON.stringify(r)); }
  assert(!validate(null).ok && !validate([]).ok && !validate("x").ok);
  check(bad.length + " kinds of bad value are refused with the field named");
  assert(validate({ texts: { trialButton: "Start {trialDays}-day trial for Rs. {trialPrice}" } }).ok); check("known {placeholders} are allowed in texts");

  // ----- 2. through the server -----
  await new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r)); await new Promise((r) => mockRazorpay.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", ADMIN_KEY: "adm1n", NVIDIA_API_KEY: "unused",
    GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port, RAZORPAY_KEY_ID: KEYID, RAZORPAY_KEY_SECRET: KEYSECRET, RAZORPAY_WEBHOOK_SECRET: WHSECRET,
    RAZORPAY_BASE_URL: "http://127.0.0.1:" + mockRazorpay.address().port, RAZORPAY_VERIFY_MIN_MS: "0"
  });
  const { start } = require("./server"); const { createMemoryCollections } = require("./memory-db");
  const cols = createMemoryCollections(); let today = "2026-10-19";
  let server = await start(cols, { today: () => today }); let base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p, body, { token, key } = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...(key ? { "x-admin-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  };
  const login = async (n) => (await call("POST", "/auth/google", { idToken: pad(n) })).body.token;
  const ADMIN = { key: "adm1n" };

  try {
    // public config
    let r = await call("GET", "/config");
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.settings, std()); assert(/max-age/.test(r.headers.get("cache-control")));
    assert(!JSON.stringify(r.body).includes("adm1n")); check("GET /config is public and returns the standard values");

    // admin access
    assert.strictEqual((await call("GET", "/admin/settings")).status, 401);
    assert.strictEqual((await call("GET", "/admin/settings", undefined, { key: "wrong" })).status, 401);
    assert.strictEqual((await call("POST", "/admin/settings", { settings: {} })).status, 401);
    check("/admin/settings needs the admin key");
    r = await call("GET", "/admin/settings", undefined, ADMIN);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.settings, std()); assert.strictEqual(r.body.updated, null);
    assert.strictEqual(r.body.defaults.plans.premium.price, 14); assert(r.body.defaults.texts.premiumInfo);
    check("GET /admin/settings returns { settings, defaults, updated }");

    // refused saves change nothing
    r = await call("POST", "/admin/settings", { settings: { wordLimit: { min: 8, max: 4 } } }, ADMIN);
    assert.strictEqual(r.status, 400); assert(r.body.errors.some((e) => e.field === "wordLimit.max" && e.message)); assert.strictEqual(cols.settings.docs.length, 0);
    r = await call("POST", "/admin/settings", {}, ADMIN); assert.strictEqual(r.status, 400); assert(r.body.errors.some((e) => e.field === "settings"));
    check("a bad save is a 400 with the field errors and stores nothing");

    // before the change
    const alice = await login("alice");
    r = await call("GET", "/auth/me", undefined, { token: alice });
    assert.strictEqual(r.body.account.dailyQuota, 13); assert.strictEqual(r.body.account.freeWords, 3); assert.strictEqual(r.body.account.remainingToday, 13);
    r = await call("POST", "/api/vocab", { text: "word ".repeat(120), wordLimit: 14 }, { token: alice });
    assert.strictEqual(r.status, 400); assert(/from 1 to 13/.test(r.body.error));

    // a real save
    const mine = { wordLimit: { min: 2, max: 8, default: 5 }, freeWords: 2, plans: { trial: { price: 3, days: 5 }, premium: { price: 29, days: 60 } }, texts: { premiumButton: "Go Premium", trialInfo: "" } };
    r = await call("POST", "/admin/settings", { settings: mine }, ADMIN);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.settings, { ...mine, texts: { premiumButton: "Go Premium" } }); assert(r.body.updated);
    assert.strictEqual(cols.settings.docs.length, 1);
    r = await call("GET", "/config"); assert.strictEqual(r.body.settings.wordLimit.max, 8); assert.strictEqual(r.body.settings.texts.premiumButton, "Go Premium");
    assert.strictEqual((await call("GET", "/admin/settings", undefined, ADMIN)).body.updated, cols.settings.docs[0].updated);
    check("a good save is stored and shown by /config and /admin/settings");

    // ... and it is used
    r = await call("GET", "/auth/me", undefined, { token: alice });
    assert.strictEqual(r.body.account.dailyQuota, 8); assert.strictEqual(r.body.account.freeWords, 2); assert.strictEqual(r.body.account.remainingToday, 8);
    check("the account shows the new daily quota and Free words");
    r = await call("POST", "/api/vocab", { text: "word ".repeat(120), wordLimit: 9 }, { token: alice });
    assert.strictEqual(r.status, 400); assert(/from 2 to 8/.test(r.body.error), r.body.error);
    r = await call("POST", "/api/vocab", { text: "word ".repeat(120), wordLimit: 1 }, { token: alice });
    assert.strictEqual(r.status, 400); assert(/from 2 to 8/.test(r.body.error));
    check("the word range is enforced from the settings");
    r = await call("GET", "/health"); assert.strictEqual(r.body.maxWordLimit, 8);

    // the daily quota drops at once for a user who had more left
    cols.users.docs.find((u) => u.email === "alice@gmail.com").daily_quota = 13; cols.users.docs.find((u) => u.email === "alice@gmail.com").last_used = today;
    r = await call("GET", "/auth/me", undefined, { token: alice }); assert.strictEqual(r.body.account.remainingToday, 8);
    check("a lowered quota applies at once to users who had more left today");

    // plan lengths
    r = await call("POST", "/admin/premium", { email: "alice@gmail.com" }, ADMIN);
    assert.strictEqual(r.status, 200); assert.strictEqual(cols.users.docs.find((u) => u.email === "alice@gmail.com").expiry_date, "2026-12-18"); // today + 60
    check("Premium length comes from the settings (60 days)");

    // prices: the payment link is created for the new price
    const bob = await login("bob");
    r = await call("POST", "/api/premium/checkout", { plan: "trial" }, { token: bob }); assert.strictEqual(r.status, 200); assert.strictEqual(lastCreate.amount, 300); assert(/5/.test(lastCreate.description));
    r = await call("POST", "/api/premium/checkout", {}, { token: bob }); assert.strictEqual(r.status, 200); assert.strictEqual(lastCreate.amount, 2900); assert(/60/.test(lastCreate.description));
    check("the Razorpay payment link is created for the new prices (Rs. 3 trial, Rs. 29 Premium)");


    // survives a restart (same database), and a bad stored document falls back to the standard values
    await new Promise((res) => server.close(res)); server = await start(cols, { today: () => today }); base = "http://127.0.0.1:" + server.address().port;
    r = await call("GET", "/config"); assert.strictEqual(r.body.settings.plans.premium.price, 29); assert.strictEqual(r.body.settings.wordLimit.max, 8);
    check("the settings survive a restart");
    cols.settings.docs[0].settings.wordLimit.max = 999; // edited by hand in the database
    await new Promise((res) => server.close(res)); server = await start(cols, { today: () => today }); base = "http://127.0.0.1:" + server.address().port;
    r = await call("GET", "/config"); assert.deepStrictEqual(r.body.settings, std());
    check("an invalid stored document is ignored: the standard values are used");

    // a server without a settings collection still works with the standard values, and refuses to save
    await new Promise((res) => server.close(res)); const noSettings = createMemoryCollections(); delete noSettings.settings;
    server = await start(noSettings, { today: () => today }); base = "http://127.0.0.1:" + server.address().port;
    r = await call("GET", "/config"); assert.strictEqual(r.body.settings.wordLimit.max, 13);
    r = await call("POST", "/admin/settings", { settings: {} }, ADMIN); assert.strictEqual(r.status, 503);
    check("without a settings collection: standard values, and saving is refused (503)");
    // the extension's own sanitize() accepts exactly what /config returns (if the extension folder is next to this one)
    try {
      const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "..", "extension", "settings.js");
      if (fs.existsSync(f)) {
        global.window = {}; global.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } }; new Function(fs.readFileSync(f, "utf8"))();
        const S = global.window.NewsVocabSettings; const cfg = (await call("GET", "/config")).body.settings;
        assert.deepStrictEqual(S.sanitize(cfg), { ...cfg, texts: { ...S.DEFAULTS.texts, ...cfg.texts } }); check("the extension's settings.js reads /config without changing a value");
      }
    } catch (e) { if (e.code === "ERR_ASSERTION") throw e; }
    console.log("\nAll settings tests passed.");
  } finally { await new Promise((res) => server.close(res)); mockGoogle.close(); mockRazorpay.close(); }
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
