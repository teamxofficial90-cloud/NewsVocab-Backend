// Dynamic settings: the numbers and texts the admin page edits (Popup settings tab), kept in MongoDB instead of in the code.
//
//   collection `settings`:  { _id: "app", settings: { ... }, updated: <ISO date> }       one document
//
// Keys (all whole numbers unless noted):
//   minWords, maxWords, defaultWords   the word-count range the popup offers, and the number it starts with.
//                                      maxWords is also the DAILY quota (a user can generate at most this many words a day).
//   freeWords                          how many words a Free-plan (expired) user is shown per batch
//   trialPrice, trialDays              the paid trial: price in rupees, length in days (counting today)
//   premiumPrice, premiumDays          Premium: price in rupees, length in days (counting today)
//   texts                              optional popup texts that replace the standard ones. A missing/blank text = "use the standard text".
//                                      keys: freeNote, trialButton, premiumButton, trialText, premiumText (each at most 300 characters)
//
// The server reads the values from memory (get()), which is refreshed from the database at most every `ttlMs` (default 15 s) and at once
// after a save, so a change made in the admin reaches every server instance within seconds and a request never waits for the database.
// A broken or missing document means the defaults below (the numbers the app always used), so the app keeps working.

const DEFAULTS = Object.freeze({
  minWords: 1, maxWords: 13, defaultWords: 10,
  freeWords: 3,
  trialPrice: 1, trialDays: 3,
  premiumPrice: 14, premiumDays: 30,
  texts: Object.freeze({})
});

// The standard texts (what the popup shows when a text is left blank). Only used to show them in the admin; they are never stored.
const STANDARD_TEXTS = Object.freeze({
  freeNote: "Free plan: only the first 3 words are shown, and the DOCX and XLSX downloads are locked. Get Premium to unlock the rest.",
  trialButton: "Start 3-day trial for Rs. 1",
  premiumButton: "Get Premium",
  trialText: "Pay Rs. 1 to get 3 days access. After that, Premium is Rs. 14 for 30 days.",
  premiumText: "Pay Rs. 14 to get 30 days access"
});
const TEXT_KEYS = Object.keys(STANDARD_TEXTS);
const TEXT_MAX = 300;
const LIMITS = { maxWords: 30, days: 365, price: 100000 }; // 30: the most words one article request can ask the AI model for

const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const toNum = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v); // the admin form may send "13" instead of 13

// Checks a settings object (the whole set, or part of it: a missing number means the standard one).
// Returns { ok:true, settings } with clean values (blank texts and unknown keys dropped), or { ok:false, errors: { field: message } }.
function validate(input) {
  const errors = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: { settings: "Send { settings: { ... } }." } };
  const s = { ...DEFAULTS, texts: {} };
  const num = (key, label, min, max) => {
    if (input[key] === undefined) return;
    const v = toNum(input[key]);
    if (!isInt(v)) { errors[key] = label + " must be a whole number."; return; }
    if (v < min) { errors[key] = label + " cannot be smaller than " + min + "."; return; }
    if (v > max) { errors[key] = label + " cannot be larger than " + max + "."; return; }
    s[key] = v;
  };
  num("minWords", "The smallest word count", 1, LIMITS.maxWords);
  num("maxWords", "The largest word count", 1, LIMITS.maxWords);
  num("defaultWords", "The starting word count", 1, LIMITS.maxWords);
  num("freeWords", "The number of Free plan words", 0, LIMITS.maxWords);
  num("trialPrice", "The trial price", 1, LIMITS.price);
  num("trialDays", "The trial length", 1, LIMITS.days);
  num("premiumPrice", "The Premium price", 1, LIMITS.price);
  num("premiumDays", "The Premium length", 1, LIMITS.days);
  // Relations between the numbers (checked only when the numbers themselves are fine, so one mistake gives one message).
  if (!errors.minWords && !errors.maxWords && s.maxWords < s.minWords) errors.maxWords = "The largest word count cannot be smaller than the smallest.";
  if (!errors.defaultWords && !errors.minWords && !errors.maxWords) {
    if (s.defaultWords < s.minWords) errors.defaultWords = "The starting word count cannot be smaller than the smallest (" + s.minWords + ").";
    else if (s.defaultWords > s.maxWords) errors.defaultWords = "The starting word count cannot be larger than the largest (" + s.maxWords + ").";
  }
  if (!errors.freeWords && !errors.maxWords && s.freeWords > s.maxWords) errors.freeWords = "The number of Free plan words cannot be larger than the largest word count (" + s.maxWords + ").";

  if (input.texts !== undefined && input.texts !== null) {
    if (typeof input.texts !== "object" || Array.isArray(input.texts)) errors.texts = "The texts must be an object.";
    else for (const k of TEXT_KEYS) {
      const v = input.texts[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") { errors["texts." + k] = "This text must be plain text."; continue; }
      const t = v.trim();
      if (!t) continue; // blank = use the standard text
      if (t.length > TEXT_MAX) { errors["texts." + k] = "This text is too long (at most " + TEXT_MAX + " characters)."; continue; }
      s.texts[k] = t;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, settings: s };
}

// `collection` is the `settings` MongoDB collection (or its in-memory stand-in); without one only the defaults are served and saving is refused.
function createSettings({ collection, ttlMs = 15000, now = Date.now } = {}) {
  let state = { settings: { ...DEFAULTS, texts: {} }, updated: null };
  let loadedAt = 0, loading = null;

  async function load() {
    if (!collection) return state;
    const doc = await collection.findOne({ _id: "app" });
    const v = doc && validate(doc.settings);
    // A stored document that no longer passes the checks (edited by hand in the database) is ignored: the defaults keep the app safe.
    if (doc && v && !v.ok) console.error("[settings] the stored settings are not valid, so the standard values are used:", JSON.stringify(v.errors));
    state = v && v.ok ? { settings: v.settings, updated: doc.updated || null } : { settings: { ...DEFAULTS, texts: {} }, updated: null };
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
    return { settings: st.settings, defaults: { ...DEFAULTS, texts: { ...STANDARD_TEXTS } }, updated: st.updated };
  }

  return { get, refresh, save, view };
}

module.exports = { createSettings, validate, DEFAULTS, STANDARD_TEXTS, TEXT_KEYS };
