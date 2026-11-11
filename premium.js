// Paid plans through Razorpay: the trial (once per account, 3 days for Rs. 1 by default) and three plans: 1 week, 1 month and 2 months. Their price and length are
// set in the admin (settings.js; defaults below). The amount paid decides the plan, and the expiry date is set by db.grantTrial / db.grantPlan.
//
// Flow
//   1. The popup's plans web page calls POST /api/premium/checkout { plan: "trial" | "week" | "month" | "twomonth" } (logged in). createCheckout() here creates a Razorpay
//      PAYMENT LINK for exactly the price of that plan from the admin settings (INR, no partial payment) and stores it in `payments` together with the user it belongs to.
//      The endpoint returns the link's short_url: that is the Razorpay payment page.
//   2. (the page opens that address)
//   3. When the user has paid, the plan is extended in one of two ways. Both end in settle(), so a payment can never count twice:
//        a) Razorpay's webhook (event payment_link.paid) calls POST /webhook/razorpay. The HMAC signature is checked first.
//        b) The popup calls POST /api/premium/verify (verifyForUser()). The backend asks Razorpay's API for the state of the user's own payment links. This works without a public URL.
//   4. settle() grants the plan only if: the payment link is one WE created, the amount paid is exactly the amount the link was created for (the price at that moment),
//      the currency is INR, and this link has not been used for a grant before (compare-and-set on `payments.status`).
// The user is always taken from our own `payments` record, never from anything the webhook or the page says.
//
// PAYMENT PAGE MODE (RAZORPAY_PAGE_MODE=on, or one or more RAZORPAY_*_PAGE_URL set; with the first the addresses of the pages live on your own web page and the server
// only confirms the payments): the owner's own Razorpay Payment Pages (a fixed amount each; each asks for email and phone) are used instead of
// generated links: RAZORPAY_TRIAL_PAGE_URL, RAZORPAY_WEEK_PAGE_URL, RAZORPAY_PAYMENT_PAGE_URL (the 1-month plan), RAZORPAY_TWOMONTH_PAGE_URL. The amount of each page must match
// the price in the admin settings. The plan is recognised by the AMOUNT of the captured payment (so the four prices must differ). Nothing is created through the Razorpay API
// (no API keys needed). The page is the same for everybody, so the payer is recognised by the EMAIL typed on the page, which must be the Gmail address of the account.
// Only the webhook can confirm such a payment (event payment.captured). A payment whose email matches no account is stored with status "unmatched" and extends nothing
// (grant it by hand with POST /admin/premium). The same checks apply: captured, exact price, INR, one payment id counts once. A trial payment of an account that has
// used its trial is stored as "trial_used" and extends nothing.
const crypto = require("crypto");

// The standard plans (used when there are no admin settings): Rs. 1 / 3 days, Rs. 7 / 7 days, Rs. 14 / 30 days, Rs. 25 / 60 days.
const PLANS = {
  trial: { paise: 100, days: 3, label: "3-day trial" },
  week: { paise: 700, days: 7, label: "Premium - 7 days" },
  month: { paise: 1400, days: 30, label: "Premium - 30 days" },
  twomonth: { paise: 2500, days: 60, label: "Premium - 60 days" }
};
const PLAN_IDS = ["trial", "week", "month", "twomonth"];
const PRICE_PAISE = PLANS.month.paise;  // Rs. 14.00 (kept for the code that only knows one Premium price)
const isPlan = (p) => PLAN_IDS.includes(p);
const planOf = (p) => (isPlan(p) ? p : "month"); // a payment record from before the three plans has "premium" or no plan: that is the 1-month plan
const CURRENCY = "INR";
const LINK_HOURS = 24;            // an unpaid payment link stops working after this long
const RAZORPAY_TIMEOUT_MS = 15000;

// The price (rupees) and length (days) of the plans come from the admin settings (settings.js) when given, else from PLANS above.
// Read at the moment of use. In payment page mode the amount of each Razorpay payment page must match the price here.
function createPremium({ db, settings, env = process.env, now = Date.now }) {
  const plans = () => {
    const s = settings && settings.get();
    if (!s) return PLANS;
    const out = {};
    for (const k of PLAN_IDS) out[k] = { paise: Math.round(s.plans[k].price * 100), days: s.plans[k].days, label: k === "trial" ? s.plans[k].days + "-day trial" : "Premium - " + s.plans[k].days + " days" };
    return out;
  };
  // Read at call time so the keys can be set (or changed) without code changes.
  const cfg = () => ({
    keyId: env.RAZORPAY_KEY_ID || "",
    keySecret: env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
    base: (env.RAZORPAY_BASE_URL || "https://api.razorpay.com").replace(/\/$/, ""),
    callbackUrl: env.RAZORPAY_CALLBACK_URL || "",
    pageUrls: {                                                      // payment page mode: one Razorpay payment page per plan
      trial: (env.RAZORPAY_TRIAL_PAGE_URL || "").trim(),
      week: (env.RAZORPAY_WEEK_PAGE_URL || "").trim(),
      month: (env.RAZORPAY_PAYMENT_PAGE_URL || env.RAZORPAY_MONTH_PAGE_URL || "").trim(),
      twomonth: (env.RAZORPAY_TWOMONTH_PAGE_URL || "").trim()
    },
    pageMatch: (env.RAZORPAY_PAGE_MATCH || "").trim().toLowerCase(),
    verifyMinMs: env.RAZORPAY_VERIFY_MIN_MS !== undefined && Number.isFinite(Number(env.RAZORPAY_VERIFY_MIN_MS)) ? Number(env.RAZORPAY_VERIFY_MIN_MS) : 3000
  });
  // Payment page mode is on when RAZORPAY_PAGE_MODE=on (the payment pages are listed on your own web page, so the server needs no addresses),
  // or when any RAZORPAY_*_PAGE_URL is set (the older way).
  const pageMode = () => /^(1|on|true|yes)$/i.test(String(env.RAZORPAY_PAGE_MODE || "").trim()) || Object.values(cfg().pageUrls).some(Boolean);
  const configured = () => { const c = cfg(); return !!(pageMode() || (c.keyId && c.keySecret)); };
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

  // Returns { url, linkId, reused }. A payment link that is still open for this user (same plan, same price) is shown again instead of creating another one.
  async function createCheckout(user, planName) {
    if (!configured()) throw fail("Payments are not set up on the server yet.", 503);
    if (!isPlan(planName)) throw fail("Unknown plan.", 400);
    const plan = planName;
    if (plan === "trial" && user.trial_used !== false) throw fail("The " + plans().trial.days + "-day trial has already been used on this account.", 409);
    if (pageMode()) { // the owner's own payment pages: the same address for everybody (one page per plan)
      const url = cfg().pageUrls[plan];
      if (!url) throw fail("This payment is not set up on the server yet.", 503);
      if (!/^https:\/\/\S+$/i.test(url)) throw fail("The payment page address for this plan on the server must be a full https:// address.", 503);
      return { url, linkId: null, reused: false, pageMode: true };
    }
    const price = plans()[plan].paise;
    const open = (await db.listCheckouts(user._id)).find((c) => planOf(c.plan) === plan && c.amount === price && new Date(c.expires_at).getTime() > now() + 60 * 1000);
    if (open) return { url: open.url, linkId: open.pid, reused: true };

    const c = cfg();
    const t = now();
    const expireBy = Math.floor(t / 1000) + LINK_HOURS * 3600;
    const body = {
      amount: plans()[plan].paise, currency: CURRENCY, accept_partial: false,
      reference_id: "nv_" + crypto.randomBytes(8).toString("hex"),
      description: "NewsVocab " + (plan === "trial" ? "trial" : "Premium") + " - " + plans()[plan].days + " days",
      customer: { email: user.email },
      notify: { email: false, sms: false }, reminder_enable: false,
      expire_by: expireBy,
      notes: { email: user.email, purpose: "newsvocab_" + plan }
    };
    if (c.callbackUrl) { body.callback_url = c.callbackUrl; body.callback_method = "get"; }
    const link = await rzp("POST", "/v1/payment_links", body);
    if (!link || !link.id || !link.short_url) throw fail("Razorpay did not return a payment page. Please try again.");
    await db.saveCheckout({ pid: link.id, user_id: user._id, email: user.email, plan, amount: plans()[plan].paise, currency: CURRENCY, status: "created", url: link.short_url, created: new Date(t), expires_at: new Date(expireBy * 1000) });
    return { url: link.short_url, linkId: link.id, reused: false };
  }

  // ----- step 3: the one place where a plan is extended -----

  // Returns { ok:true, granted:true|false } or { ok:false, reason }. Never throws for a bad payment; throws only for database errors.
  async function settle({ linkId, amountPaid, currency, paymentId, source }) {
    const co = await db.getCheckout(linkId);
    if (!co) return { ok: false, reason: "UNKNOWN_LINK" };               // not a link this server created
    if (co.status === "granted") return { ok: true, granted: false };     // already used: a repeated webhook or a second check
    const plan = planOf(co.plan); // a link created before the three plans existed has "premium" or no plan: it is a 1-month link
    // The amount must be exactly what WE asked Razorpay for when the link was created. It is not compared with today's price: if the admin changes a price
    // while a link is open, a user who pays that link still gets the plan he was shown.
    if (!Number.isInteger(co.amount) || amountPaid !== co.amount) return { ok: false, reason: "AMOUNT" };
    if (currency !== CURRENCY) return { ok: false, reason: "CURRENCY" };
    if (!(await db.claimCheckout(linkId, { payment_id: paymentId || "", paid_at: new Date(now()), source }))) return { ok: true, granted: false }; // another request got there first
    try {
      const user = plan === "trial" ? await db.grantTrial(co.email) : await db.grantPlan(co.email, plan);
      if (user === false) { console.warn("[premium] trial paid by an account that already used it (handle by hand):", co.email, linkId); return { ok: false, reason: "TRIAL_USED" }; }
      if (!user) throw new Error("No account for " + co.email);
      return { ok: true, granted: true, email: user.email, plan };
    } catch (e) {
      await db.releaseCheckout(linkId).catch(() => {}); // let the next webhook retry / check try again
      throw e;
    }
  }

  // Payment page mode: one captured payment -> the account with the same email. Returns { ok, granted?, reason? } like settle().
  async function settlePagePayment(pay, source) {
    if (!pay || !pay.id) return { ok: false, reason: "INCOMPLETE" };
    if (pay.status !== "captured") return { ok: false, reason: "NOT_PAID" };
    const P = plans(); const plan = PLAN_IDS.find((k) => pay.amount === P[k].paise) || null; // the amount decides the plan; if two prices are equal the first one in PLAN_IDS wins
    if (!plan) return { ok: false, reason: "AMOUNT" };
    if (pay.currency !== CURRENCY) return { ok: false, reason: "CURRENCY" };
    const must = cfg().pageMatch; // optional: only payments of this page (text found in the payment's description or notes)
    if (must && !(String(pay.description || "") + " " + JSON.stringify(pay.notes || {})).toLowerCase().includes(must)) return { ok: false, reason: "OTHER_PAYMENT" };
    const email = String(pay.email || "").trim().toLowerCase();
    const user = email ? await db.getUser(email) : null;
    const base = { pid: pay.id, kind: "page", plan, email, amount: pay.amount, currency: pay.currency, payment_id: pay.id, contact: String(pay.contact || ""), paid_at: new Date(now()), source };
    if (!user) { // nobody has this email: keep the record so it can be handled by hand, extend nothing
      await db.recordPagePayment({ ...base, status: "unmatched" });
      return { ok: false, reason: "NO_ACCOUNT" };
    }
    if (plan === "trial" && user.trial_used !== false) { // paid for a trial this account already had: keep the record, extend nothing
      await db.recordPagePayment({ ...base, status: "trial_used", user_id: user._id });
      return { ok: false, reason: "TRIAL_USED" };
    }
    if (!(await db.recordPagePayment({ ...base, status: "granted", user_id: user._id }))) return { ok: true, granted: false }; // this payment id was handled before
    try {
      const granted = plan === "trial" ? await db.grantTrial(email) : await db.grantPlan(email, plan);
      if (granted === false) { // the trial was used by another payment a moment ago
        await db.releasePagePayment(pay.id).catch(() => {});
        await db.recordPagePayment({ ...base, status: "trial_used", user_id: user._id });
        return { ok: false, reason: "TRIAL_USED" };
      }
      if (!granted) throw new Error("No account for " + email);
      return { ok: true, granted: true, email, plan };
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

  return { configured, pageMode, webhookConfigured, createCheckout, handleWebhook, verifyForUser, settle, PRICE_PAISE, PLANS, plans };
}

module.exports = { createPremium, PRICE_PAISE, PLANS, PLAN_IDS, CURRENCY };
