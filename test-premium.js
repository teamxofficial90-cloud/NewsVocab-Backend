// Premium purchase test (Razorpay): payment page creation, webhook signature + amount checks, single use of a payment,
// and the "ask Razorpay" check, through the real server with a mock Razorpay API, a mock Google tokeninfo server and in-memory collections.
// Run: node test-premium.js
const http = require("http"); const crypto = require("crypto"); const assert = require("assert");

const CLIENT = "test-client.apps.googleusercontent.com", WHSECRET = "whsec_test", KEYID = "rzp_test_id", KEYSECRET = "rzp_test_secret";
const exp = () => String(Math.floor(Date.now() / 1000) + 3600);
const tok = (email, sub) => ({ aud: CLIENT, iss: "https://accounts.google.com", exp: exp(), email_verified: "true", sub, email });
const tokens = { alice: tok("alice@gmail.com", "1"), bob: tok("bob@gmail.com", "2"), carol: tok("carol@gmail.com", "3"), frank: tok("frank@gmail.com", "6"), gina: tok("gina@gmail.com", "7"), hank: tok("hank@gmail.com", "8") };
const pad = (k) => k + "_" + "x".repeat(30);

const mockGoogle = http.createServer((req, res) => {
  const t = new URL(req.url, "http://x").searchParams.get("id_token") || "";
  const claims = tokens[t.split("_")[0]];
  res.writeHead(claims ? 200 : 400, { "content-type": "application/json" }); res.end(JSON.stringify(claims || { error: "invalid_token" }));
});

// Mock Razorpay: remembers the payment links it created, and what state each is in (tests change `state`).
const links = new Map(); let created = 0; let lastCreateBody = null, lastAuth = "";
const mockRazorpay = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    lastAuth = req.headers.authorization || "";
    const json = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (lastAuth !== "Basic " + Buffer.from(KEYID + ":" + KEYSECRET).toString("base64")) return json(401, { error: { description: "Authentication failed" } });
    if (req.method === "POST" && req.url === "/v1/payment_links") {
      lastCreateBody = JSON.parse(b); created++;
      const id = "plink_" + created;
      links.set(id, { id, status: "created", amount: lastCreateBody.amount, amount_paid: 0, currency: lastCreateBody.currency, payments: null });
      return json(200, { ...links.get(id), short_url: "https://rzp.io/i/" + id });
    }
    const m = req.url.match(/^\/v1\/payment_links\/(.+)$/);
    if (req.method === "GET" && m && links.has(m[1])) return json(200, links.get(m[1]));
    json(404, { error: { description: "not found" } });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r));
  await new Promise((r) => mockRazorpay.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", ADMIN_KEY: "adm1n", GEMINI_API_KEY: "unused",
    GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port,
    RAZORPAY_BASE_URL: "http://127.0.0.1:" + mockRazorpay.address().port, RAZORPAY_VERIFY_MIN_MS: "0"
  });
  const { start } = require("./server");
  const { createMemoryCollections } = require("./memory-db");
  const { addDays } = require("./db");
  const cols = createMemoryCollections();
  let today = "2026-10-19";
  const server = await start(cols, { today: () => today });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const login = async (name) => (await call("POST", "/auth/google", { idToken: pad(name) })).body.token;
  const sign = (raw, secret = WHSECRET) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const webhook = (event, secret) => { const raw = JSON.stringify(event); return call("POST", "/webhook/razorpay", raw, null, { "x-razorpay-signature": sign(raw, secret) }); };
  const paidEvent = (linkId, amount = 900, over = {}) => ({
    event: "payment_link.paid",
    payload: { payment_link: { entity: { id: linkId, status: "paid", amount: 900, amount_paid: amount } }, payment: { entity: { id: "pay_" + linkId, amount, currency: "INR", status: "captured", ...over } } }
  });
  const expiryOf = (email) => cols.users.docs.find((u) => u.email === email).expiry_date;
  const check = (name) => console.log("ok -", name);

  try {
    // --- login required ---
    let r = await call("POST", "/api/premium/checkout"); assert.equal(r.status, 401); assert.equal(r.body.code, "AUTH_REQUIRED");
    r = await call("POST", "/api/premium/verify"); assert.equal(r.status, 401);
    check("checkout and verify need a login");

    const alice = await login("alice");
    // --- not configured yet ---
    r = await call("POST", "/api/premium/checkout", undefined, alice); assert.equal(r.status, 503); assert.match(r.body.error, /not set up/);
    r = await webhook(paidEvent("plink_1")); assert.equal(r.status, 404); // webhook secret not set: endpoint is off
    check("without Razorpay keys the server says payments are not set up, and the webhook is off");

    Object.assign(process.env, { RAZORPAY_KEY_ID: KEYID, RAZORPAY_KEY_SECRET: KEYSECRET, RAZORPAY_WEBHOOK_SECRET: WHSECRET });
    let health = (await call("GET", "/health")).body; assert.equal(health.paymentsConfigured, true); assert.equal(health.paymentWebhookConfigured, true);

    // --- the plan expires; alice presses Get Premium ---
    today = addDays("2026-10-19", 5); // the 5-day trial is over
    assert.equal((await call("POST", "/api/vocab", { text: "x" }, alice)).status, 400); // (just proves the session works; the plan check comes after the text check)
    r = await call("POST", "/api/premium/checkout", undefined, alice);
    assert.equal(r.status, 200); assert.equal(r.body.url, "https://rzp.io/i/plink_1");
    assert.equal(lastCreateBody.amount, 900); assert.equal(lastCreateBody.currency, "INR"); assert.equal(lastCreateBody.accept_partial, false);
    assert.equal(lastCreateBody.notes.email, "alice@gmail.com");
    assert.ok(lastCreateBody.expire_by > Date.now() / 1000 + 3600);
    assert.equal(created, 1);
    r = await call("POST", "/api/premium/checkout", undefined, alice); assert.equal(r.body.url, "https://rzp.io/i/plink_1"); assert.equal(created, 1); // same open link, no second one
    assert.equal(cols.payments.docs.length, 1); assert.equal(cols.payments.docs[0].status, "created");
    check("checkout creates one Rs. 9.00 INR payment link for the user and shows the same link again while it is open");

    const before = expiryOf("alice@gmail.com");
    assert.ok(!(today < before)); // expired

    // --- webhook: wrong signature / wrong amount / unknown link / not captured: no grant ---
    let raw = JSON.stringify(paidEvent("plink_1"));
    r = await call("POST", "/webhook/razorpay", raw, null, { "x-razorpay-signature": sign(raw, "wrong-secret") }); assert.equal(r.status, 400);
    r = await call("POST", "/webhook/razorpay", raw); assert.equal(r.status, 400); // no signature header
    assert.equal(expiryOf("alice@gmail.com"), before);
    r = await webhook(paidEvent("plink_1", 500)); assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.equal(expiryOf("alice@gmail.com"), before);
    r = await webhook(paidEvent("plink_1", 900, { currency: "USD" })); assert.equal(r.body.ok, false); assert.equal(r.body.reason, "CURRENCY"); assert.equal(expiryOf("alice@gmail.com"), before);
    r = await webhook(paidEvent("plink_1", 900, { status: "authorized" })); assert.equal(r.body.reason, "NOT_PAID"); assert.equal(expiryOf("alice@gmail.com"), before);
    r = await webhook(paidEvent("plink_999")); assert.equal(r.body.ok, false); assert.equal(r.body.reason, "UNKNOWN_LINK"); assert.equal(expiryOf("alice@gmail.com"), before);
    r = await webhook({ event: "payment.failed", payload: {} }); assert.equal(r.status, 200); assert.equal(r.body.ignored, true);
    assert.equal(cols.payments.docs[0].status, "created");
    check("webhook: bad signature, wrong amount, wrong currency, uncaptured payment, unknown link and other events never extend the plan");

    // --- webhook: the real payment ---
    r = await webhook(paidEvent("plink_1")); assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.granted, true);
    assert.equal(expiryOf("alice@gmail.com"), addDays(today, 21));
    assert.equal(cols.payments.docs[0].status, "granted"); assert.equal(cols.payments.docs[0].payment_id, "pay_plink_1"); assert.equal(cols.payments.docs[0].source, "webhook");
    let me = (await call("GET", "/auth/me", undefined, alice)).body; assert.equal(me.account.active, true); assert.equal(me.account.validUntil, addDays(today, 20));
    check("a correct Rs. 9.00 payment sets the expiry date to today + 20 days (21 days counting today)");

    // --- the same payment again (Razorpay retries) and later: no second extension ---
    const granted = expiryOf("alice@gmail.com");
    today = addDays(today, 5);
    r = await webhook(paidEvent("plink_1")); assert.equal(r.body.ok, true); assert.equal(r.body.granted, false); assert.equal(expiryOf("alice@gmail.com"), granted);
    links.get("plink_1").status = "paid"; links.get("plink_1").amount_paid = 900; // the verify path sees the same payment too
    r = await call("POST", "/api/premium/verify", undefined, alice); assert.equal(r.body.granted, false); assert.equal(expiryOf("alice@gmail.com"), granted);
    // two copies of the same webhook at the very same moment
    const bob = await login("bob"); today = addDays(today, 10);
    await call("POST", "/api/premium/checkout", undefined, bob); // plink_2
    const results = await Promise.all([webhook(paidEvent("plink_2")), webhook(paidEvent("plink_2")), webhook(paidEvent("plink_2"))]);
    assert.equal(results.filter((x) => x.body.granted === true).length, 1);
    assert.equal(expiryOf("bob@gmail.com"), addDays(today, 21));
    check("a payment counts once (repeated and simultaneous webhooks, and the verify check afterwards)");

    // --- the popup's check (no webhook): ask Razorpay ---
    const carol = await login("carol"); today = addDays(today, 5);
    r = await call("POST", "/api/premium/verify", undefined, carol); assert.equal(r.body.granted, false); // nothing created yet
    await call("POST", "/api/premium/checkout", undefined, carol); // plink_3
    const carolExpiry = expiryOf("carol@gmail.com");
    r = await call("POST", "/api/premium/verify", undefined, carol); assert.equal(r.body.granted, false); assert.equal(expiryOf("carol@gmail.com"), carolExpiry); // link still unpaid
    links.get("plink_3").status = "paid"; links.get("plink_3").amount_paid = 500; // paid, but not the right amount
    r = await call("POST", "/api/premium/verify", undefined, carol); assert.equal(r.body.granted, false); assert.equal(expiryOf("carol@gmail.com"), carolExpiry); assert.equal(cols.payments.docs.find((p) => p.pid === "plink_3").status, "created");
    links.get("plink_3").amount_paid = 900; links.get("plink_3").payments = [{ payment_id: "pay_abc", amount: 900, status: "captured" }];
    r = await call("POST", "/api/premium/verify", undefined, carol);
    assert.equal(r.body.granted, true); assert.equal(expiryOf("carol@gmail.com"), addDays(today, 21)); assert.equal(r.body.account.active, true); assert.equal(r.body.account.validUntil, addDays(today, 20));
    const rec = cols.payments.docs.find((p) => p.pid === "plink_3"); assert.equal(rec.status, "granted"); assert.equal(rec.payment_id, "pay_abc"); assert.equal(rec.source, "verify");
    r = await webhook(paidEvent("plink_3")); assert.equal(r.body.granted, false); // the webhook arriving later finds it already used
    check("verify: unpaid and wrong-amount links change nothing; the correct payment extends the plan once");

    // --- a link of another user is never used for the wrong account ---
    const aliceBefore = expiryOf("alice@gmail.com");
    links.set("plink_x", { id: "plink_x", status: "paid", amount: 900, amount_paid: 900, currency: "INR" }); // a link this server never created
    r = await call("POST", "/api/premium/verify", undefined, alice); assert.equal(expiryOf("alice@gmail.com"), aliceBefore);
    check("only payment links created by this server for that user count");

    // --- throttle ---
    process.env.RAZORPAY_VERIFY_MIN_MS = "60000";
    r = await call("POST", "/api/premium/verify", undefined, bob); assert.equal(r.body.throttled, false); // bob has not checked before
    r = await call("POST", "/api/premium/verify", undefined, bob); assert.equal(r.body.throttled, true);
    process.env.RAZORPAY_VERIFY_MIN_MS = "0";
    check("verify is rate limited per user");

    // --- Razorpay down / bad keys: a clean error, nothing granted ---
    process.env.RAZORPAY_KEY_SECRET = "wrong";
    const erin = (tokens.erin = tok("erin@gmail.com", "5"), await login("erin"));
    r = await call("POST", "/api/premium/checkout", undefined, erin); assert.equal(r.status, 502); assert.match(r.body.error, /not set up correctly/);
    process.env.RAZORPAY_KEY_SECRET = KEYSECRET;
    check("wrong Razorpay keys give a clear error");

    // =====================================================================================================
    // PAYMENT PAGE MODE: RAZORPAY_PAYMENT_PAGE_URL is set, so the owner's own page is used (no API keys, payer found by email)
    // =====================================================================================================
    const capturedEvent = (id, email, over = {}) => ({ event: "payment.captured", payload: { payment: { entity: { id, amount: 900, currency: "INR", status: "captured", captured: true, email, contact: "+919999999999", description: "NewsVocab Premium", notes: [], ...over } } } });
    const frank = await login("frank"), gina = await login("gina"), hank = await login("hank");
    today = addDays(today, 30); // every account is expired again
    const linksBefore = created;

    // In link mode a payment.captured webhook is not used (the link's own payment_link.paid event is the one that counts)
    r = await webhook(capturedEvent("pay_L1", "frank@gmail.com")); assert.equal(r.body.ignored, true); assert.equal(expiryOf("frank@gmail.com") < today, true);

    Object.assign(process.env, { RAZORPAY_PAYMENT_PAGE_URL: "https://rzp.io/l/newsvocab-premium" });
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; // page mode needs no API keys
    health = (await call("GET", "/health")).body; assert.equal(health.paymentMode, "page"); assert.equal(health.paymentsConfigured, true);
    r = await call("POST", "/api/premium/checkout", undefined, frank);
    assert.equal(r.status, 200); assert.equal(r.body.url, "https://rzp.io/l/newsvocab-premium"); assert.equal(r.body.pageMode, true); assert.equal(r.body.email, "frank@gmail.com");
    assert.equal(created, linksBefore, "no payment link is created through the API in page mode");
    process.env.RAZORPAY_PAYMENT_PAGE_URL = "http://insecure.example/page"; // must be https
    r = await call("POST", "/api/premium/checkout", undefined, frank); assert.equal(r.status, 503); assert.match(r.body.error, /https/);
    process.env.RAZORPAY_PAYMENT_PAGE_URL = "https://rzp.io/l/newsvocab-premium";
    check("page mode: Get Premium returns the page from .env (needs https, no API keys, no link created) and tells the popup which email to use");

    // the popup's check only refreshes the account (it cannot confirm a page payment itself)
    r = await call("POST", "/api/premium/verify", undefined, frank); assert.equal(r.body.granted, false); assert.equal(r.body.pageMode, true); assert.equal(r.body.account.active, false);
    check("page mode: the popup check just reports the account");

    // refused payments
    const fexp = expiryOf("frank@gmail.com");
    let raw2 = JSON.stringify(capturedEvent("pay_P0", "frank@gmail.com"));
    r = await call("POST", "/webhook/razorpay", raw2, null, { "x-razorpay-signature": sign(raw2, "wrong") }); assert.equal(r.status, 400);
    r = await webhook(capturedEvent("pay_P1", "frank@gmail.com", { amount: 500 })); assert.equal(r.body.reason, "AMOUNT");
    r = await webhook(capturedEvent("pay_P2", "frank@gmail.com", { currency: "USD" })); assert.equal(r.body.reason, "CURRENCY");
    r = await webhook(capturedEvent("pay_P3", "frank@gmail.com", { status: "authorized", captured: false })); assert.equal(r.body.reason, "NOT_PAID");
    r = await webhook(capturedEvent("pay_P4", "")); assert.equal(r.body.reason, "NO_ACCOUNT");
    assert.equal(expiryOf("frank@gmail.com"), fexp);
    check("page mode: bad signature, wrong amount, wrong currency, uncaptured payment and a payment without email extend nothing");

    // an email nobody has: recorded as unmatched, nothing extended, repeated webhook does not make a second record
    r = await webhook(capturedEvent("pay_U1", "stranger@gmail.com")); assert.equal(r.body.ok, false); assert.equal(r.body.reason, "NO_ACCOUNT");
    r = await webhook(capturedEvent("pay_U1", "stranger@gmail.com")); assert.equal(r.body.ok, false);
    const unmatched = cols.payments.docs.filter((d) => d.pid === "pay_U1"); assert.equal(unmatched.length, 1); assert.equal(unmatched[0].status, "unmatched"); assert.equal(unmatched[0].email, "stranger@gmail.com");
    check("page mode: a payment with an email that has no account is recorded as unmatched and extends nothing");

    // the real payment (email in other letter case): plan = today + 20 days (21 days counting today), once
    r = await webhook(capturedEvent("pay_F1", "Frank@Gmail.com")); assert.equal(r.status, 200); assert.equal(r.body.granted, true);
    assert.equal(expiryOf("frank@gmail.com"), addDays(today, 21));
    const rec2 = cols.payments.docs.find((d) => d.pid === "pay_F1"); assert.equal(rec2.status, "granted"); assert.equal(rec2.kind, "page"); assert.equal(rec2.source, "webhook");
    me = (await call("GET", "/auth/me", undefined, frank)).body; assert.equal(me.account.active, true); assert.equal(me.account.validUntil, addDays(today, 20));
    r = await call("POST", "/api/premium/verify", undefined, frank); assert.equal(r.body.account.active, true); assert.equal(r.body.pageMode, true); // the popup now sees the new plan
    check("page mode: a captured Rs. 9.00 payment sets the expiry to today + 20 days (21 days counting today) for the account with that email (any letter case)");

    // the same payment again, and three at the same moment
    const fgranted = expiryOf("frank@gmail.com"); today = addDays(today, 3);
    r = await webhook(capturedEvent("pay_F1", "frank@gmail.com")); assert.equal(r.body.ok, true); assert.equal(r.body.granted, false); assert.equal(expiryOf("frank@gmail.com"), fgranted);
    const many = await Promise.all([1, 2, 3].map(() => webhook(capturedEvent("pay_G1", "gina@gmail.com"))));
    assert.equal(many.filter((x) => x.body.granted === true).length, 1); assert.equal(expiryOf("gina@gmail.com"), addDays(today, 21));
    check("page mode: a payment id counts once (repeated and simultaneous webhooks)");

    // a failed grant is undone so Razorpay's retry can succeed
    const realGrant = cols.users.updateOne.bind(cols.users); let failOnce = true;
    cols.users.updateOne = async (...a) => { if (failOnce && a[1] && a[1].$set && a[1].$set.expiry_date) { failOnce = false; throw new Error("db down"); } return realGrant(...a); };
    const hexp = expiryOf("hank@gmail.com");
    r = await webhook(capturedEvent("pay_H1", "hank@gmail.com")); assert.equal(r.status, 500); assert.equal(expiryOf("hank@gmail.com"), hexp); assert.ok(!cols.payments.docs.find((d) => d.pid === "pay_H1"));
    r = await webhook(capturedEvent("pay_H1", "hank@gmail.com")); assert.equal(r.body.granted, true); assert.equal(expiryOf("hank@gmail.com"), addDays(today, 21));
    cols.users.updateOne = realGrant;
    check("page mode: if the database fails the payment is not marked as used, and the webhook retry extends the plan");

    // optional filter: only payments of this page
    process.env.RAZORPAY_PAGE_MATCH = "newsvocab premium";
    const iris = tok("iris@gmail.com", "9"); tokens.iris = iris; await login("iris"); today = addDays(today, 30);
    const iexp = expiryOf("iris@gmail.com");
    r = await webhook(capturedEvent("pay_I1", "iris@gmail.com", { description: "Some other product" })); assert.equal(r.body.reason, "OTHER_PAYMENT"); assert.equal(expiryOf("iris@gmail.com"), iexp);
    r = await webhook(capturedEvent("pay_I2", "iris@gmail.com", { description: "NewsVocab Premium - 21 days" })); assert.equal(r.body.granted, true);
    delete process.env.RAZORPAY_PAGE_MATCH;
    check("page mode: RAZORPAY_PAGE_MATCH keeps other payments of the Razorpay account out");

    delete process.env.RAZORPAY_PAYMENT_PAGE_URL;
    Object.assign(process.env, { RAZORPAY_KEY_ID: KEYID, RAZORPAY_KEY_SECRET: KEYSECRET });

    // --- the admin grant still works ---
    r = await call("POST", "/admin/premium", { email: "erin@gmail.com" }, null, { "x-admin-key": "adm1n" }); assert.equal(r.status, 200); assert.equal(expiryOf("erin@gmail.com"), addDays(today, 21));
    check("manual /admin/premium still works");

    console.log("\nAll premium tests passed.");
  } catch (e) { console.error("\nFAILED:", e); process.exitCode = 1; }
  server.close(); mockGoogle.close(); mockRazorpay.close(); process.exit(process.exitCode || 0);
})();
