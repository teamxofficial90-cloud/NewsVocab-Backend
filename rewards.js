// "Earn free days": extra days for things the user does for the product (a review, an Instagram share, a referral ...).
// The DEVELOPER controls everything from rewards.json (path: REWARDS_FILE in .env). The file is read again whenever it changes, so
// switching the whole feature off, or one reward, or changing the days needs no restart:
//   { "enabled": true,                         // false = the button disappears from the popup and every endpoint refuses
//     "referral": { "enabled": true, "title", "description", "days": 7 (the new user), "ownerDays": 3 (the owner of the code, per friend), "maxReferrals": 5 },
//     "rewards": [ { "id": "review", "enabled": true, "title", "description", "days": 5, "url": "https://...", "approval": "manual" | "auto" } ] }
// Each reward (and the referral) has "apply":
//   "next_premium" (default): the days are NOT given at once. They are saved on the account (bonus_days) and added to the user's NEXT
//                             Premium plan (21 + saved days).
//   "now":                    the days are added to the CURRENT plan at once (an active plan is extended from its end; an expired one
//                             restarts today, so 3 days = today .. today + 2).
// PROOF: the server cannot see a review or an Instagram post, so a claim of a link reward must carry the user's proof (their Instagram post
// link or username, the name on their review ...). It is checked for FORMAT, saved with the claim, shown to the developer in
// GET /admin/rewards/pending (so the post or review can be looked up before approving), and the same proof can be used only once per reward
// (a second account cannot reuse someone else's post). Per reward: "proof": { "type": "instagram_post" | "instagram" | "text", "label": "...", "required": true }.
//   instagram_post : a link to an Instagram post or reel (the strongest proof: the developer opens it and sees the post is really there)
//   instagram      : an Instagram username (@name) or a post / profile link
//   text           : any text of 3-100 characters (for example the name shown on the review)
// Two kinds of reward:
//   * link rewards (rewards[]): the popup opens `url`, the user presses "I have done it". The server cannot see a review or an Instagram
//     post, so "approval": "manual" keeps the claim `pending` until the developer approves it (POST /admin/rewards/decide); "auto" gives the
//     days at once (honour system). One claim per user per reward, ever.
//   * referral: each user has a code. A NEW user can enter a friend's code once, in the step right after sign-up (the popup shows it, with a
//     Skip button); BOTH the new user and the code's owner then get `days`, as set by "apply" (by default saved for their next Premium plan).
//     It is verified by the server, so it is always granted at once. `maxReferrals` caps how many friends can pay out to one owner.
//     Two people can never refer each other (that would pay both of them twice): only an account that has not used or skipped the sign-up
//     step can enter a code (`ref_pending`), the owner's own chance is closed the moment somebody uses their code, a code of someone who
//     joined with your code is refused, and a simultaneous mutual use is detected and undone.
const fs = require("fs");
const path = require("path");

const REF_CODE = /^[A-Z0-9]{6,12}$/;
const ID = /^[a-z0-9_-]{1,40}$/;
const clean = (v, max) => String(v === undefined || v === null ? "" : v).trim().slice(0, max);
const wholeDays = (v, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 365 ? n : dflt; };


// Turns what the user typed into { display, key, link }: `display` is what the developer sees, `key` is what makes two proofs "the same"
// (case and @ ignored), `link` is a page the developer can open. Throws a friendly error when it does not look like what is asked for.
const IG_POST = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})\/?(?:[?#].*)?$/i;
const IG_PROFILE = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i;
const IG_HANDLE = /^@?([A-Za-z0-9._]{1,30})$/;
function normalizeProof(type, raw) {
  const v = clean(raw, 300).replace(/\s+/g, " ");
  const bad = (m) => { const e = new Error(m); e.status = 400; e.friendly = true; e.code = "BAD_PROOF"; return e; };
  if (!v) throw bad("Please enter the proof first.");
  const post = v.match(IG_POST);
  if (type === "instagram_post" || (type === "instagram" && post)) {
    if (!post) throw bad("Please paste the link of your Instagram post or reel (it looks like https://www.instagram.com/p/XXXXX/).");
    const kind = post[1].toLowerCase() === "reels" ? "reel" : post[1].toLowerCase();
    const link = "https://www.instagram.com/" + kind + "/" + post[2] + "/";
    return { display: link, key: "post:" + post[2], link };
  }
  if (type === "instagram") {
    const handle = (v.match(IG_HANDLE) || v.match(IG_PROFILE) || [])[1];
    if (!handle || /^(p|reel|reels|tv|explore|accounts)$/i.test(handle)) throw bad("Please enter your Instagram username (for example @yourname) or the link of your post.");
    return { display: "@" + handle, key: "user:" + handle.toLowerCase(), link: "https://www.instagram.com/" + handle + "/" };
  }
  if (v.length < 3 || v.length > 100) throw bad("Please enter at least 3 characters (the name or ID shown on your review).");
  return { display: v, key: "text:" + v.toLowerCase(), link: "" };
}

function createRewards({ db, env = process.env }) {
  let cache = { mtime: -1, file: "", cfg: { enabled: false, referral: { enabled: false }, rewards: [] } };

  // Reads and checks rewards.json (again only when the file has changed). A missing or broken file means "feature off".
  const PROOF_TYPES = { instagram_post: "Link to your Instagram post or reel", instagram: "Your Instagram username or post link", text: "The name or ID shown on your review" };
  function proofConfig(p) {
    const type = p && PROOF_TYPES[p.type] ? p.type : "text";
    return { required: !(p && p.required === false), type, label: clean(p && p.label, 100) || PROOF_TYPES[type] };
  }

  function config() {
    const file = env.REWARDS_FILE || path.join(__dirname, "rewards.json");
    let st; try { st = fs.statSync(file); } catch (e) { cache = { mtime: -1, file, cfg: { enabled: false, referral: { enabled: false }, rewards: [] } }; return cache.cfg; }
    if (cache.file === file && cache.mtime === st.mtimeMs) return cache.cfg;
    let raw; try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("[rewards] " + file + " is not valid JSON, so the feature is off until it is fixed."); cache = { mtime: st.mtimeMs, file, cfg: { enabled: false, referral: { enabled: false }, rewards: [] } }; return cache.cfg; }
    const seen = new Set(); const rewards = [];
    for (const r of Array.isArray(raw.rewards) ? raw.rewards : []) {
      const id = clean(r && r.id, 40);
      if (!ID.test(id) || id === "referral" || id === "referred" || seen.has(id)) { console.error("[rewards] skipped a reward with a missing, repeated or reserved id:", id); continue; }
      seen.add(id);
      const url = clean(r.url, 500);
      rewards.push({ id, enabled: r.enabled !== false, title: clean(r.title, 80) || id, description: clean(r.description, 300), days: wholeDays(r.days, 1),
                     url: /^https:\/\/\S+$/i.test(url) ? url : "", approval: r.approval === "auto" ? "auto" : "manual", apply: r.apply === "now" ? "now" : "next_premium", proof: proofConfig(r.proof) });
    }
    const f = raw.referral || {};
    const referral = { enabled: raw.enabled !== false && f.enabled === true, title: clean(f.title, 80) || "Refer a friend", description: clean(f.description, 300),
                       days: wholeDays(f.days, 7), ownerDays: wholeDays(f.ownerDays, wholeDays(f.days, 7)), apply: f.apply === "now" ? "now" : "next_premium", maxReferrals: Number.isInteger(f.maxReferrals) && f.maxReferrals >= 1 ? f.maxReferrals : 10 };
    cache = { mtime: st.mtimeMs, file, cfg: { enabled: raw.enabled === true, referral, rewards } };
    return cache.cfg;
  }

  const fail = (message, status, code) => { const e = new Error(message); e.status = status || 400; e.friendly = true; if (code) e.code = code; return e; };
  const off = () => fail("This feature is not available right now.", 404, "REWARDS_OFF");
  const keyOf = (user, id) => String(user._id) + ":" + id;
  // Gives the days the way the reward says: onto the current plan now, or saved for the next Premium plan.
  const give = (email, days, apply) => (apply === "now" ? db.extendDays(email, days) : db.addBonus(email, days));

  // What the popup shows. { enabled:false } hides the button.
  async function list(user) {
    const cfg = config();
    if (!cfg.enabled) return { enabled: false };
    const mine = await db.listRewards(user._id);
    const byReward = new Map(mine.map((m) => [m.reward, m]));
    const me = (await db.getUser(user.email)) || user;
    const out = { enabled: true, bonusDays: me.bonus_days || 0, rewards: cfg.rewards.filter((r) => r.enabled).map((r) => {
      const m = byReward.get(r.id);
      return { id: r.id, title: r.title, description: r.description, days: r.days, url: r.url, approval: r.approval, apply: r.apply, proof: r.proof.required ? { type: r.proof.type, label: r.proof.label } : null, status: m ? m.status : "available" };
    }) };
    if (cfg.referral.enabled) {
      const referred = mine.filter((m) => m.reward === "referral" && m.status === "granted").length;
      const fresh = me;
      out.referral = { title: cfg.referral.title, description: cfg.referral.description, days: cfg.referral.days, ownerDays: cfg.referral.ownerDays, apply: cfg.referral.apply, code: await db.getRefCode(fresh), referred, maxReferrals: cfg.referral.maxReferrals };
    }
    if (!out.rewards.length && !out.referral) return { enabled: false };
    return out;
  }

  // The user says they did the thing, and gives the proof. Returns { status: "granted" | "pending", days, apply }.
  async function claim(user, id, rawProof) {
    const cfg = config();
    if (!cfg.enabled) throw off();
    const r = cfg.rewards.find((x) => x.id === id && x.enabled);
    if (!r) throw fail("That reward is not available.", 404);
    const key = keyOf(user, r.id);
    const alreadyClaimed = (old) => fail(old && old.status === "pending" ? "You already claimed this. It is waiting for approval." : old && old.status === "rejected" ? "This claim was not approved." : "You already got the days for this.", 409, "ALREADY_CLAIMED");
    const earlier = await db.getReward(key);
    if (earlier) throw alreadyClaimed(earlier); // one claim per user per reward, whatever proof they now give
    // The proof: checked for format, and one proof can be used for one claim only (so a post or review cannot be reused by other accounts).
    let proof = null; let lock = null;
    if (r.proof.required) {
      proof = normalizeProof(r.proof.type, rawProof);
      lock = "proof:" + r.id + ":" + proof.key;
      if (!(await db.insertReward({ key: lock, reward: r.id, status: "proof", created: new Date() }))) throw fail("This " + (r.proof.type === "text" ? "name or ID" : "post or username") + " has already been used for this reward.", 409, "PROOF_USED");
    }
    const doc = { key, user_id: user._id, email: user.email, reward: r.id, days: r.days, apply: r.apply, status: r.approval === "auto" ? "granted" : "pending", created: new Date(),
                  ...(proof ? { proof: proof.display, proof_link: proof.link, proof_key: lock } : {}) };
    let inserted = false;
    try { inserted = await db.insertReward(doc); } catch (e) { if (lock) await db.deleteReward(lock).catch(() => {}); throw e; }
    if (!inserted) { // another click of the same user got there first
      if (lock) await db.deleteReward(lock).catch(() => {});
      throw alreadyClaimed(await db.getReward(key));
    }
    if (doc.status === "pending") return { status: "pending", days: r.days, apply: r.apply };
    try { await give(user.email, r.days, r.apply); }
    catch (e) { await db.deleteReward(key).catch(() => {}); if (lock) await db.deleteReward(lock).catch(() => {}); throw e; } // the days could not be added: forget the claim so it can be tried again
    return { status: "granted", days: r.days, apply: r.apply };
  }

  // A friend's code, entered in the step right after sign-up. BOTH accounts get `days` (apply: saved for the next Premium plan, or added now).
  // Returns { days, apply }.
  async function redeem(user, rawCode) {
    const cfg = config();
    if (!cfg.enabled || !cfg.referral.enabled) throw off();
    const me = (await db.getUser(user.email)) || user;
    // Only a new account that has neither used nor skipped the step. Everybody else (old accounts, people who skipped) is refused.
    if (me.ref_pending !== true) throw fail("A referral code can only be entered right after you sign up.", 409, "REFERRAL_CLOSED");
    const code = clean(rawCode, 20).toUpperCase().replace(/[\s-]/g, "");
    if (!REF_CODE.test(code)) throw fail("That code is not valid. Check it and try again.", 400);
    const owner = await db.findByRefCode(code);
    if (!owner) throw fail("That code is not valid. Check it and try again.", 404);
    if (String(owner._id) === String(me._id)) throw fail("You cannot use your own code.", 400);
    const mutual = () => fail("You cannot use the code of a friend who joined with your code. A referral works one way only.", 409, "MUTUAL_REFERRAL");
    if (owner.referred_by && String(owner.referred_by) === String(me._id)) throw mutual();
    const paid = (await db.listRewards(owner._id)).filter((m) => m.reward === "referral" && m.status === "granted").length;
    if (paid >= cfg.referral.maxReferrals) throw fail("This code has reached its limit.", 409);

    // 1. Claim the step (compare-and-set on ref_pending: it works once, even with several clicks at the same moment).
    if (!(await db.claimReferral(me._id, owner._id))) throw fail("You have already used or skipped the referral step.", 409, "REFERRAL_CLOSED");
    // 2. Two people using each other's codes at the very same moment: both claims got through, so each sees the other's claim here and both
    //    undo theirs (nobody is paid; one of them can enter the code again).
    const again = await db.getUser(owner.email);
    if (again && again.referred_by && String(again.referred_by) === String(me._id)) { await db.reopenReferral(me._id).catch(() => {}); throw mutual(); }

    // 3. Pay both. The owner's record is what counts towards maxReferrals; the friend's own record ("referred") is only a receipt.
    const ownerKey = String(owner._id) + ":referral:" + String(me._id), meKey = String(me._id) + ":referred";
    const undo = async (gaveOwner) => {
      await db.deleteReward(ownerKey).catch(() => {}); await db.deleteReward(meKey).catch(() => {});
      if (gaveOwner && cfg.referral.apply !== "now") await db.addBonus(owner.email, -cfg.referral.ownerDays).catch(() => {}); // saved days can be taken back; days added to a plan cannot, so that case is only logged
      else if (gaveOwner) console.error("[referral] the owner's days were added but the friend's could not be: owner " + owner.email + ", friend " + me.email);
      await db.reopenReferral(me._id).catch(() => {});
    };
    let gaveOwner = false;
    try {
      const base = { apply: cfg.referral.apply, status: "granted", created: new Date() };
      await db.insertReward({ ...base, days: cfg.referral.ownerDays, key: ownerKey, user_id: owner._id, email: owner.email, reward: "referral", friend: me.email });
      await db.insertReward({ ...base, days: cfg.referral.days, key: meKey, user_id: me._id, email: me.email, reward: "referred", friend: owner.email });
      await give(owner.email, cfg.referral.ownerDays, cfg.referral.apply); gaveOwner = true;
      await give(me.email, cfg.referral.days, cfg.referral.apply);
    } catch (e) { await undo(gaveOwner); throw e; }

    // 4. The owner's own chance to enter a code is over (only if it was still open), so a chain can never close into a circle.
    await db.closeReferral(owner._id).catch(() => {});
    return { days: cfg.referral.days, ownerDays: cfg.referral.ownerDays, apply: cfg.referral.apply };
  }

  // "Skip": the new user does not want to enter a code. Closes the step for good. Safe to call twice.
  async function skipReferral(user) {
    const me = (await db.getUser(user.email)) || user;
    await db.closeReferral(me._id);
    return { ok: true };
  }

  // ----- developer side -----
  const pending = async () => (await db.listPendingRewards()).map((m) => ({ email: m.email, reward: m.reward, days: m.days, proof: m.proof || "", link: m.proof_link || "", created: m.created }));

  // Approve (days are added) or reject a pending claim. Returns { ok, status } or { ok:false, reason }.
  async function decide(email, id, approve) {
    const user = await db.getUser(email);
    if (!user) return { ok: false, reason: "NO_ACCOUNT" };
    const key = keyOf(user, id);
    const m = await db.getReward(key);
    if (!m) return { ok: false, reason: "NO_CLAIM" };
    if (m.status !== "pending") return { ok: false, reason: "ALREADY_DECIDED", status: m.status };
    if (!(await db.decideReward(key, approve ? "granted" : "rejected"))) return { ok: false, reason: "ALREADY_DECIDED" };
    if (approve) {
      try { await give(user.email, m.days, m.apply); }
      catch (e) { await db.undecideReward(key).catch(() => {}); throw e; }
    }
    return { ok: true, status: approve ? "granted" : "rejected", days: m.days, apply: m.apply || "next_premium", proof: m.proof || "" };
  }

  return { config, list, claim, redeem, skipReferral, pending, decide, normalizeProof };
}

module.exports = { createRewards, normalizeProof };
