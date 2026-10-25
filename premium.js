// Premium purchase through Razorpay (Rs. 9.00 -> the plan runs until today + 20 days, i.e. 21 days counting today).
//
// Flow
//   1. The popup's "Get Premium" button calls POST /api/premium/checkout. The backend creates a Razorpay PAYMENT LINK for exactly
//      Rs. 9.00 (900 paise, INR, no partial payment) and stores it in `payments` together with the user it belongs to.
//      The popup opens the link's short_url in a new tab: that is the Razorpay payment page.
//   2. When the user has paid, the plan is extended in one of two ways. Both end in settle(), so a payment can never count twice:
//        a) Razorpay's webhook (event payment_link.paid) calls POST /webhook/razorpay. The HMAC signature is checked first.
//        b) The popup calls POST /api/premium/verify (when it opens with an expired plan, and from the "I have paid" button).
//           The backend asks Razorpay's API for the state of the user's own payment links. This works without a public URL.
//   3. settle() grants the plan only if: the payment link is one WE created, the amount paid is exactly 900 paise, the currency is
//      INR, and this link has not been used for a grant before (compare-and-set on `payments.status`).
// The user is always taken from our own `payments` record, never from anything the webhook or the page says.
//
// PAYMENT PAGE MODE (RAZORPAY_PAYMENT_PAGE_URL set): the owner's own Razorpay Payment Page (fixed amount Rs. 9.00, asks for email and phone) is
// used instead of generated links. Nothing is created through the Razorpay API (no API keys needed). The page is the same for everybody,
// so the payer is recognised by the EMAIL typed on the page, which must be the Gmail address of the account. Only the webhook can confirm
// such a payment (event payment.captured). A payment whose email matches no account is stored with status "unmatched" and extends nothing
// (grant it by hand with POST /admin/premium). The same checks apply: captured, exactly 900 paise, INR, one payment id counts once.
const crypto = require("crypto");

const PRICE_PAISE = 900;          // Rs. 9.00
const CURRENCY = "INR";
const LINK_HOURS = 24;            // an unpaid payment link stops working after this long
const RAZORPAY_TIMEOUT_MS = 15000;

function createPremium({ db, env = process.env, now = Date.now }) {
  // Read at call time so the keys can be set (or changed) without code changes.
  const cfg = () => ({
    keyId: env.RAZORPAY_KEY_ID || "",
    keySecret: env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
    base: (env.RAZORPAY_BASE_URL || "https://api.razorpay.com").replace(/\/$/, ""),
    callbackUrl: env.RAZORPAY_CALLBACK_URL || "",
    pageUrl: (env.RAZORPAY_PAYMENT_PAGE_URL || "").trim(),
    pageMatch: (env.RAZORPAY_PAGE_MATCH || "").trim().toLowerCase(),
    verifyMinMs: env.RAZORPAY_VERIFY_MIN_MS !== undefined && Number.isFinite(Number(env.RAZORPAY_VERIFY_MIN_MS)) ? Number(env.RAZORPAY_VERIFY_MIN_MS) : 3000
  });
  const pageMode = () => !!cfg().pageUrl;
  const configured = () => { const c = cfg(); return !!(c.pageUrl || (c.keyId && c.keySecret)); };
  const webhookConfigured = () => !!cfg().webhookSecret;

  const fail = (message, status) => { const e = new Error(message); e.status = status || 502; e.friendly = true; return e; };

  async function rzp(method, path, body) {
    const c = cfg();
    let res;
    try {
      res = await fetch(c.base + path, {
        method,
        signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
        headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(c.keyId + ":" + c.keySecret).toString("base64") },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) { throw fail("Could not reach Razorpay. Please try again in a moment."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[razorpay]", method, path, res.status, data && data.error && data.error.description);
      throw fail(res.status === 401 ? "Payments are not set up correctly on the server (Razorpay rejected the keys)." : "Razorpay could not process the request. Please try again.");
    }
    return data;
  }

  // ----- step 1: the payment page -----

  // Returns { url, linkId, reused }. A payment link that is still open for this user is shown again instead of creating another one.
  async function createCheckout(user) {
    if (!configured()) throw fail("Payments are not set up on the server yet.", 503);
    if (pageMode()) { // the owner's own payment page: the same address for everybody
      const url = cfg().pageUrl;
      if (!/^https:\/\/\S+$/i.test(url)) throw fail("RAZORPAY_PAYMENT_PAGE_URL on the server must be a full https:// address.", 503);
      return { url, linkId: null, reused: false, pageMode: true };
    }
    const open = (await db.listCheckouts(user._id)).find((c) => new Date(c.expires_at).getTime() > now() + 60 * 1000);
    if (open) return { url: open.url, linkId: open.pid, reused: true };

    const c = cfg();
    const t = now();
    const expireBy = Math.floor(t / 1000) + LINK_HOURS * 3600;
    const body = {
      amount: PRICE_PAISE, currency: CURRENCY, accept_partial: false,
      reference_id: "nv_" + crypto.randomBytes(8).toString("hex"),
      description: "NewsVocab Premium - " + (db.constants.PREMIUM_DAYS + 1) + " days",
      customer: { email: user.email },
      notify: { email: false, sms: false }, reminder_enable: false,
      expire_by: expireBy,
      notes: { email: user.email, purpose: "newsvocab_premium" }
    };
    if (c.callbackUrl) { body.callback_url = c.callbackUrl; body.callback_method = "get"; }
    const link = await rzp("POST", "/v1/payment_links", body);
    if (!link || !link.id || !link.short_url) throw fail("Razorpay did not return a payment page. Please try again.");
    await db.saveCheckout({ pid: link.id, user_id: user._id, email: user.email, amount: PRICE_PAISE, currency: CURRENCY, status: "created", url: link.short_url, created: new Date(t), expires_at: new Date(expireBy * 1000) });
    return { url: link.short_url, linkId: link.id, reused: false };
  }

  // ----- step 3: the one place where a plan is extended -----

  // Returns { ok:true, granted:true|false } or { ok:false, reason }. Never throws for a bad payment; throws only for database errors.
  async function settle({ linkId, amountPaid, currency, paymentId, source }) {
    const co = await db.getCheckout(linkId);
    if (!co) return { ok: false, reason: "UNKNOWN_LINK" };               // not a link this server created
    if (co.status === "granted") return { ok: true, granted: false };     // already used: a repeated webhook or a second check
    if (amountPaid !== PRICE_PAISE || co.amount !== PRICE_PAISE) return { ok: false, reason: "AMOUNT" };
    if (currency !== CURRENCY) return { ok: false, reason: "CURRENCY" };
    if (!(await db.claimCheckout(linkId, { payment_id: paymentId || "", paid_at: new Date(now()), source }))) return { ok: true, granted: false }; // another request got there first
    try {
      const user = await db.grantPremium(co.email);
      if (!user) throw new Error("No account for " + co.email);
      return { ok: true, granted: true, email: user.email };
    } catch (e) {
      await db.releaseCheckout(linkId).catch(() => {}); // let the next webhook retry / check try again
      throw e;
    }
  }

  // Payment page mode: one captured payment -> the account with the same email. Returns { ok, granted?, reason? } like settle().
  async function settlePagePayment(pay, source) {
    if (!pay || !pay.id) return { ok: false, reason: "INCOMPLETE" };
    if (pay.status !== "captured") return { ok: false, reason: "NOT_PAID" };
    if (pay.amount !== PRICE_PAISE) return { ok: false, reason: "AMOUNT" };
    if (pay.currency !== CURRENCY) return { ok: false, reason: "CURRENCY" };
    const must = cfg().pageMatch; // optional: only payments of this page (text found in the payment's description or notes)
    if (must && !(String(pay.description || "") + " " + JSON.stringify(pay.notes || {})).toLowerCase().includes(must)) return { ok: false, reason: "OTHER_PAYMENT" };
    const email = String(pay.email || "").trim().toLowerCase();
    const user = email ? await db.getUser(email) : null;
    const base = { pid: pay.id, kind: "page", email, amount: pay.amount, currency: pay.currency, payment_id: pay.id, contact: String(pay.contact || ""), paid_at: new Date(now()), source };
    if (!user) { // nobody has this email: keep the record so it can be handled by hand, extend nothing
      await db.recordPagePayment({ ...base, status: "unmatched" });
      return { ok: false, reason: "NO_ACCOUNT" };
    }
    if (!(await db.recordPagePayment({ ...base, status: "granted", user_id: user._id }))) return { ok: true, granted: false }; // this payment id was handled before
    try {
      const granted = await db.grantPremium(email);
      if (!granted) throw new Error("No account for " + email);
      return { ok: true, granted: true, email };
    } catch (e) {
      await db.releasePagePayment(pay.id).catch(() => {}); // let Razorpay's retry of the webhook try again
      throw e;
    }
  }

  // ----- step 2a: the webhook -----

  const signatureOk = (raw, header) => {
    const secret = cfg().webhookSecret;
    if (!secret || typeof header !== "string" || !/^[0-9a-f]{64}$/i.test(header)) return false;
    const expected = crypto.createHmac("sha256", secret).update(raw).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(header, "hex"));
  };

  // `raw` is the exact request body (a Buffer): the signature is calculated over those bytes. Returns { status, body }.
  async function handleWebhook(raw, signature) {
    if (!webhookConfigured()) return { status: 404, body: { error: "Not found" } };
    if (!signatureOk(raw, signature)) return { status: 400, body: { error: "Bad signature." } };
    let evt; try { evt = JSON.parse(raw.toString("utf8")); } catch (e) { return { status: 400, body: { error: "Invalid JSON." } }; }
    const p = (evt && evt.payload) || {};
    if (evt && evt.event === "payment.captured" && pageMode()) { // payment page mode: the payer is found by the email on the page
      const r = await settlePagePayment(p.payment && p.payment.entity, "webhook");
      if (!r.ok) console.warn("[premium webhook] page payment not used:", r.reason, p.payment && p.payment.entity && p.payment.entity.id);
      return { status: 200, body: r };
    }
    if (!evt || evt.event !== "payment_link.paid") return { status: 200, body: { ok: true, ignored: true } }; // other events are not needed
    const link = p.payment_link && p.payment_link.entity;
    const pay = p.payment && p.payment.entity;
    if (!link || !link.id || !pay) return { status: 200, body: { ok: false, reason: "INCOMPLETE" } };
    if (link.status !== "paid" || pay.status !== "captured") return { status: 200, body: { ok: false, reason: "NOT_PAID" } };
    if (link.amount_paid !== undefined && link.amount_paid !== pay.amount) return { status: 200, body: { ok: false, reason: "AMOUNT" } };
    const r = await settle({ linkId: link.id, amountPaid: pay.amount, currency: pay.currency, paymentId: pay.id, source: "webhook" });
    if (!r.ok) console.warn("[premium webhook] payment ignored:", r.reason, link.id);
    return { status: 200, body: r }; // 200 also for refused payments: Razorpay must not retry something that will never be valid. A database error throws -> 500 -> Razorpay retries.
  }

  // ----- step 2b: ask Razorpay directly (no public URL needed) -----

  const lastVerify = new Map(); // user id -> time of the last check, so a popup cannot hammer Razorpay
  async function verifyForUser(user) {
    if (pageMode()) return { granted: false, pageMode: true }; // a page payment can only be confirmed by the webhook; the popup just refreshes the account
    if (!configured()) throw fail("Payments are not set up on the server yet.", 503);
    const key = String(user._id), t = now(), min = cfg().verifyMinMs;
    if (min > 0 && t - (lastVerify.get(key) || 0) < min) return { granted: false, throttled: true };
    lastVerify.set(key, t);
    if (lastVerify.size > 5000) lastVerify.delete(lastVerify.keys().next().value);

    let granted = false;
    for (const co of await db.listCheckouts(user._id, 5)) { // newest first; includes links that have expired since they were paid
      const link = await rzp("GET", "/v1/payment_links/" + encodeURIComponent(co.pid));
      if (!link || link.status !== "paid") continue;
      const first = Array.isArray(link.payments) && link.payments[0];
      const r = await settle({ linkId: co.pid, amountPaid: link.amount_paid, currency: link.currency, paymentId: (first && first.payment_id) || "", source: "verify" });
      if (!r.ok) console.warn("[premium verify] payment ignored:", r.reason, co.pid);
      if (r.granted) granted = true;
    }
    return { granted };
  }

  return { configured, pageMode, webhookConfigured, createCheckout, handleWebhook, verifyForUser, settle, PRICE_PAISE };
}

module.exports = { createPremium, PRICE_PAISE, CURRENCY };
