// Dynamic settings: the numbers and texts the admin page edits (Popup settings tab), kept in MongoDB instead of in the code.
// The shape is the one the extension's settings.js reads from GET /config, so the admin, the backend and the popup all use the same fields:
//
//   collection `settings`:  { _id: "app", settings: { ... }, updated: <ISO date> }       one document
//
//   {
//     wordLimit: { min: 1, max: 13, default: 10 },   the word-count range the popup offers and its starting number.
//                                                    `max` is also the DAILY quota (a user can generate at most this many words a day).
//     freeWords: 3,                                  words of a batch a Free-plan (expired) user is shown
//     plans: { trial:   { price: 1,  days: 3 },      price in rupees (up to 2 decimals), length in days counting today
//              premium: { price: 14, days: 30 } },
//     texts: { tagline, premiumButton, trialButton, premiumInfo, trialInfo }   optional; a missing/blank text = the standard text.
//            may use {trialDays} {trialPrice} {premiumDays} {premiumPrice} {freeWords} {minLimit} {maxLimit}
//   }
//
// The server reads the values from memory (get()), which is refreshed from the database at most every `ttlMs` (default 15 s) and at once
// after a save, so a change made in the admin reaches every server instance within seconds and a request never waits for the database.
// A broken or missing document means the defaults below (the numbers the app always used), so the app keeps working.

const DEFAULTS = Object.freeze({
  wordLimit: Object.freeze({ min: 1, max: 13, default: 10 }),
  freeWords: 3,
  plans: Object.freeze({ trial: Object.freeze({ price: 1, days: 3 }), premium: Object.freeze({ price: 14, days: 30 }) }),
  texts: Object.freeze({})
});

// The standard texts (what the popup shows when a text is left blank). Shown in the admin as the defaults; never stored.
const STANDARD_TEXTS = Object.freeze({
  tagline: "Learn vocabulary from the news you read",
  premiumButton: "Get Premium",
  trialButton: "Start {trialDays}-day trial for Rs. {trialPrice}",
  premiumInfo: "Pay Rs. {premiumPrice} to get {premiumDays} days access",
  trialInfo: "Pay Rs. {trialPrice} to get {trialDays} days access. After that, Premium is Rs. {premiumPrice} for {premiumDays} days."
});
const TEXT_KEYS = Object.keys(STANDARD_TEXTS);
const TEXT_VARS = ["trialDays", "trialPrice", "premiumDays", "premiumPrice", "freeWords", "minLimit", "maxLimit"]; // the placeholders the popup knows
const TEXT_MAX = 300;
const LIMITS = { maxWords: 30, days: 3650, price: 100000 }; // 30: the most words one article request can ask the AI model for

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const toNum = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v); // the admin form may send "13" instead of 13
const fresh = () => ({ wordLimit: { ...DEFAULTS.wordLimit }, freeWords: DEFAULTS.freeWords, plans: { trial: { ...DEFAULTS.plans.trial }, premium: { ...DEFAULTS.plans.premium } }, texts: {} });

// Checks a settings object (the whole set, or part of it: a missing value means the standard one).
// Returns { ok:true, settings } with clean values (blank texts and unknown keys dropped), or { ok:false, errors: { "dotted.field": message } }.
function validate(input) {
  const errors = {};
  if (!isObj(input)) return { ok: false, errors: { settings: "Send { settings: { ... } }." } };
  const s = fresh();
  const num = (value, path, label, min, max, set, { decimals = false } = {}) => {
    if (value === undefined) return;
    const v = toNum(value);
    if (typeof v !== "number" || !Number.isFinite(v)) { errors[path] = label + " must be a number."; return; }
    if (!decimals && !Number.isInteger(v)) { errors[path] = label + " must be a whole number."; return; }
    if (decimals && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) { errors[path] = label + " can have at most 2 decimals."; return; }
    if (v < min) { errors[path] = label + " cannot be smaller than " + min + "."; return; }
    if (v > max) { errors[path] = label + " cannot be larger than " + max + "."; return; }
    set(decimals ? Math.round(v * 100) / 100 : v);
  };
  const part = (name) => { const v = input[name]; if (v === undefined) return {}; if (!isObj(v)) { errors[name] = "This must be an object."; return {}; } return v; };

  const w = part("wordLimit");
  num(w.min, "wordLimit.min", "The smallest word count", 1, LIMITS.maxWords, (v) => (s.wordLimit.min = v));
  num(w.max, "wordLimit.max", "The largest word count", 1, LIMITS.maxWords, (v) => (s.wordLimit.max = v));
  num(w.default, "wordLimit.default", "The starting word count", 1, LIMITS.maxWords, (v) => (s.wordLimit.default = v));
  num(input.freeWords, "freeWords", "The number of Free plan words", 0, LIMITS.maxWords, (v) => (s.freeWords = v));
  // Relations between the numbers (checked only when the numbers themselves are fine, so one mistake gives one message).
  if (!errors["wordLimit.min"] && !errors["wordLimit.max"] && s.wordLimit.max < s.wordLimit.min) errors["wordLimit.max"] = "The largest word count cannot be smaller than the smallest.";
  if (!errors["wordLimit.default"] && !errors["wordLimit.min"] && !errors["wordLimit.max"]) {
    if (s.wordLimit.default < s.wordLimit.min) errors["wordLimit.default"] = "The starting word count cannot be smaller than the smallest (" + s.wordLimit.min + ").";
    else if (s.wordLimit.default > s.wordLimit.max) errors["wordLimit.default"] = "The starting word count cannot be larger than the largest (" + s.wordLimit.max + ").";
  }
  if (!errors.freeWords && !errors["wordLimit.max"] && s.freeWords > s.wordLimit.max) errors.freeWords = "The number of Free plan words cannot be larger than the largest word count (" + s.wordLimit.max + ").";

  const plans = part("plans");
  for (const k of ["trial", "premium"]) {
    const p = plans[k] === undefined ? {} : plans[k];
    if (!isObj(p)) { errors["plans." + k] = "This must be an object."; continue; }
    const name = k === "trial" ? "trial" : "Premium";
    num(p.price, "plans." + k + ".price", "The " + name + " price", 1, LIMITS.price, (v) => (s.plans[k].price = v), { decimals: true });
    num(p.days, "plans." + k + ".days", "The " + name + " length", 1, LIMITS.days, (v) => (s.plans[k].days = v));
  }

  if (input.texts !== undefined && input.texts !== null) {
    if (!isObj(input.texts)) errors.texts = "The texts must be an object.";
    else for (const k of TEXT_KEYS) {
      const v = input.texts[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") { errors["texts." + k] = "This text must be plain text."; continue; }
      const t = v.trim();
      if (!t) continue; // blank = use the standard text
      if (t.length > TEXT_MAX) { errors["texts." + k] = "This text is too long (at most " + TEXT_MAX + " characters)."; continue; }
      const unknown = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).find((x) => !TEXT_VARS.includes(x));
      if (unknown) { errors["texts." + k] = "{" + unknown + "} is not a known placeholder. Use " + TEXT_VARS.map((x) => "{" + x + "}").join(" "); continue; }
      s.texts[k] = t;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, settings: s };
}

// `collection` is the `settings` MongoDB collection (or its in-memory stand-in); without one only the defaults are served and saving is refused.
function createSettings({ collection, ttlMs = 15000, now = Date.now } = {}) {
  let state = { settings: fresh(), updated: null };
  let loadedAt = 0, loading = null;

  async function load() {
    if (!collection) return state;
    const doc = await collection.findOne({ _id: "app" });
    const v = doc && validate(doc.settings);
    // A stored document that no longer passes the checks (edited by hand in the database) is ignored: the defaults keep the app safe.
    if (doc && v && !v.ok) console.error("[settings] the stored settings are not valid, so the standard values are used:", JSON.stringify(v.errors));
    state = v && v.ok ? { settings: v.settings, updated: doc.updated || null } : { settings: fresh(), updated: null };
    loadedAt = now();
    return state;
  }

  // Reads the database now (concurrent callers share one read). On a database error the last known values stay in use.
  function refresh() {
    if (!loading) loading = load().catch((e) => { console.error("[settings] could not read the database:", e.message); loadedAt = now(); return state; }).finally(() => { loading = null; });
    return loading;
  }

  // The current settings, from memory (never waits). When they are older than ttlMs a refresh starts in the background.
  function get() {
    if (collection && now() - loadedAt > ttlMs) refresh();
    return state.settings;
  }

  // Validates and stores. Returns { ok:true, settings, updated } or { ok:false, errors }. Throws only on a database error.
  async function save(input) {
    if (!collection) { const e = new Error("Settings cannot be saved on this server (no database)."); e.status = 503; throw e; }
    const v = validate(input);
    if (!v.ok) return v;
    const updated = new Date(now()).toISOString();
    await collection.updateOne({ _id: "app" }, { $set: { settings: v.settings, updated } }, { upsert: true });
    state = { settings: v.settings, updated };
    loadedAt = now();
    return { ok: true, settings: v.settings, updated };
  }

  // What GET /admin/settings returns.
  async function view() {
    const st = await refresh();
    return { settings: st.settings, defaults: { ...fresh(), texts: { ...STANDARD_TEXTS } }, updated: st.updated };
  }

  return { get, refresh, save, view };
}

module.exports = { createSettings, validate, fresh, DEFAULTS, STANDARD_TEXTS, TEXT_KEYS };
