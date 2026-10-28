// "Earn free days" test: the developer switches (rewards.json), review / Instagram claims with manual and automatic approval,
// the referral code, one-time rules and the caps, through the real server with a mock Google tokeninfo server and in-memory collections.
// Run: node test-rewards.js
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const assert = require("assert");

const CLIENT = "test-client.apps.googleusercontent.com";
const exp = () => String(Math.floor(Date.now() / 1000) + 3600);
const names = ["alice", "bob", "carol", "dave", "erin", "frank", "gina", "hank", "ivan", "jane", "kate", "lena", "mona", "nick", "omar", "pia", "quin", "rita", "sara", "tina", "uma", "wil", "xia", "yan", "zed"];
const tokens = Object.fromEntries(names.map((n, i) => [n, { aud: CLIENT, iss: "https://accounts.google.com", exp: exp(), email_verified: "true", sub: String(i + 1), email: n + "@gmail.com" }]));
const pad = (k) => k + "_" + "x".repeat(30);
const mockGoogle = http.createServer((req, res) => {
  const t = new URL(req.url, "http://x").searchParams.get("id_token") || "";
  const claims = tokens[t.split("_")[0]];
  res.writeHead(claims ? 200 : 400, { "content-type": "application/json" }); res.end(JSON.stringify(claims || { error: "invalid_token" }));
});

const file = path.join(os.tmpdir(), "nv-rewards-" + Date.now() + ".json");
const base0 = {
  enabled: true,
  referral: { enabled: true, title: "Refer a friend", description: "d", days: 7, maxReferrals: 10 },
  rewards: [
    { id: "review", enabled: true, title: "Review", description: "r", days: 5, url: "https://store.example/x", approval: "manual", proof: { type: "text", label: "Your review name" } },
    { id: "instagram", enabled: true, title: "Instagram", description: "i", days: 5, url: "https://www.instagram.com/", approval: "manual", proof: { type: "instagram_post", label: "Post link" } }
  ]
};
let stamp = 1;
const setConfig = (patch) => { // the developer edits the file; no restart
  const c = JSON.parse(JSON.stringify(base0)); patch(c);
  fs.writeFileSync(file, JSON.stringify(c)); const t = new Date(Date.now() + 1000 * stamp++); fs.utimesSync(file, t, t);
};

(async () => {
  await new Promise((r) => mockGoogle.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { PORT: "0", HOST: "127.0.0.1", GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: "s3cret", ADMIN_KEY: "adm1n", GEMINI_API_KEY: "unused",
    GOOGLE_TOKENINFO_URL: "http://127.0.0.1:" + mockGoogle.address().port, REWARDS_FILE: file });
  setConfig(() => {});
  const { start } = require("./server"); const { createMemoryCollections } = require("./memory-db"); const { addDays } = require("./db");
  const cols = createMemoryCollections(); let today = "2026-10-19";
  const server = await start(cols, { today: () => today });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const login = async (n) => (await call("POST", "/auth/google", { idToken: pad(n) })).body.token;
  const userOf = (n) => cols.users.docs.find((u) => u.email === n + "@gmail.com");
  const expiryOf = (n) => userOf(n).expiry_date; const bonusOf = (n) => userOf(n).bonus_days || 0;
  const admin = { "x-admin-key": "adm1n" };
  const check = (m) => console.log("ok -", m);
  let pn = 0; const P = (id) => (id === "instagram" ? "https://www.instagram.com/p/Zz" + String(++pn).padStart(6, "0") + "/" : "Reviewer " + (++pn)); // a different proof every time

  try {
    let r = await call("GET", "/api/rewards"); assert.equal(r.status, 401); r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }); assert.equal(r.status, 401);
    r = await call("POST", "/api/rewards/redeem", { code: "ABCDEFGH" }); assert.equal(r.status, 401);
    check("the rewards endpoints need a login");

    const alice = await login("alice"); const bob = await login("bob"); const carol = await login("carol");
    assert.equal(expiryOf("alice"), "2026-10-19", "no free days at signup: the account starts on the Free plan");

    // --- the developer's master switch ---
    setConfig((c) => { c.enabled = false; });
    r = await call("GET", "/api/rewards", undefined, alice); assert.equal(r.status, 200); assert.equal(r.body.enabled, false); assert.equal(r.body.rewards, undefined);
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, alice); assert.equal(r.status, 404); assert.equal(r.body.code, "REWARDS_OFF");
    r = await call("POST", "/api/rewards/redeem", { code: "ABCDEFGH" }, alice); assert.equal(r.status, 404);
    assert.equal((await call("GET", "/health")).body.rewardsEnabled, false);
    assert.equal((await call("GET", "/auth/me", undefined, alice)).body.account.refPending, false, "feature off: the popup is not asked to show the referral step");
    // a broken file also means "off", and it comes back when fixed
    fs.writeFileSync(file, "{ not json"); const t0 = new Date(Date.now() + 500000); fs.utimesSync(file, t0, t0);
    assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.enabled, false);
    fs.unlinkSync(file); assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.enabled, false);
    check("with the switch off (or a missing or broken file) the feature is hidden and refused, with no restart");

    setConfig(() => {});
    r = await call("GET", "/api/rewards", undefined, alice);
    assert.equal(r.body.enabled, true); assert.deepEqual(r.body.rewards.map((x) => [x.id, x.days, x.status]), [["review", 5, "available"], ["instagram", 5, "available"]]);
    assert.equal(r.body.rewards[0].url, "https://store.example/x"); assert.equal(r.body.referral.days, 7); assert.match(r.body.referral.code, /^[A-Z2-9]{8}$/); assert.equal((await call("GET", "/auth/me", undefined, alice)).body.account.refPending, true, "alice signed up just now: the referral step is open"); assert.equal((await call("GET", "/auth/me", undefined, alice)).body.account.refDays, 7);
    const code = r.body.referral.code; assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.referral.code, code, "the code stays the same");
    assert.equal((await call("GET", "/health")).body.rewardsEnabled, true);
    check("switched on: the list shows each reward, its days and link, and the user's own referral code");

    // --- one reward off ---
    setConfig((c) => { c.rewards[1].enabled = false; });
    r = await call("GET", "/api/rewards", undefined, alice); assert.deepEqual(r.body.rewards.map((x) => x.id), ["review"]);
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: P("instagram") }, alice); assert.equal(r.status, 404);
    r = await call("POST", "/api/rewards/claim", { id: "nope" }, alice); assert.equal(r.status, 404);
    setConfig((c) => { c.rewards = []; c.referral.enabled = false; }); assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.enabled, false, "nothing left to show: the button hides");
    setConfig(() => {});
    check("a single reward (or the referral) can be switched off on its own");

    // --- manual approval: pending until the developer decides ---
    const before = expiryOf("alice");
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, alice); assert.equal(r.status, 200); assert.equal(r.body.status, "pending");
    assert.equal(expiryOf("alice"), before, "nothing is added before the approval");
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, alice); assert.equal(r.status, 409); assert.equal(r.body.code, "ALREADY_CLAIMED"); assert.match(r.body.error, /waiting/);
    assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.rewards[0].status, "pending");
    r = await call("GET", "/admin/rewards/pending"); assert.equal(r.status, 401);
    r = await call("GET", "/admin/rewards/pending", undefined, null, admin); assert.deepEqual(r.body.pending.map((p) => [p.email, p.reward, p.days]), [["alice@gmail.com", "review", 5]]);
    r = await call("POST", "/admin/rewards/decide", { email: "alice@gmail.com", reward: "review", approve: true }); assert.equal(r.status, 401);
    r = await call("POST", "/admin/rewards/decide", { email: "alice@gmail.com", reward: "review" }, null, admin); assert.equal(r.status, 400);
    r = await call("POST", "/admin/rewards/decide", { email: "nobody@gmail.com", reward: "review", approve: true }, null, admin); assert.equal(r.status, 404);
    r = await call("POST", "/admin/rewards/decide", { email: "alice@gmail.com", reward: "instagram", approve: true }, null, admin); assert.equal(r.status, 404, "no claim, nothing to approve");
    r = await call("POST", "/admin/rewards/decide", { email: "Alice@gmail.com", reward: "review", approve: true }, null, admin); assert.equal(r.status, 200); assert.equal(r.body.status, "granted");
    assert.equal(expiryOf("alice"), before, "the plan itself is NOT changed"); assert.equal(bonusOf("alice"), 5, "the 5 days are saved for the next Premium plan");
    assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.bonusDays, 5); assert.equal((await call("GET", "/auth/me", undefined, alice)).body.account.bonusDays, 5);
    r = await call("POST", "/admin/rewards/decide", { email: "alice@gmail.com", reward: "review", approve: true }, null, admin); assert.equal(r.status, 409); assert.equal(bonusOf("alice"), 5, "approving twice adds nothing");
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, alice); assert.equal(r.status, 409); assert.match(r.body.error, /already got/);
    assert.equal((await call("GET", "/api/rewards", undefined, alice)).body.rewards[0].status, "granted");
    assert.equal((await call("GET", "/admin/rewards/pending", undefined, null, admin)).body.pending.length, 0);
    check("manual approval: pending adds nothing, the developer approves once, the days are saved as bonus (the plan is not changed), a reward counts only once");

    // --- rejected claim ---
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: P("instagram") }, alice); assert.equal(r.body.status, "pending");
    r = await call("POST", "/admin/rewards/decide", { email: "alice@gmail.com", reward: "instagram", approve: false }, null, admin); assert.equal(r.body.status, "rejected");
    assert.equal(bonusOf("alice"), 5); r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: P("instagram") }, alice); assert.equal(r.status, 409); assert.match(r.body.error, /not approved/);
    check("a rejected claim adds nothing and cannot be claimed again");

    // --- an expired (Free) plan stays Free: the days wait for the next Premium plan ---
    today = addDays("2026-10-19", 20); assert.ok(!(today < expiryOf("bob")));
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, bob); assert.equal(r.body.status, "pending");
    await call("POST", "/admin/rewards/decide", { email: "bob@gmail.com", reward: "review", approve: true }, null, admin);
    assert.equal(bonusOf("bob"), 5); r = await call("GET", "/auth/me", undefined, bob); assert.equal(r.body.account.active, false, "still Free: the reward gives no access by itself");
    r = await call("POST", "/api/vocab", { title: "t", text: "w ".repeat(150), wordLimit: 1 }, bob); assert.notEqual(r.status, 403, "a Free user still generates as before");
    // the next Premium plan (a payment or the manual grant use the same code) = 30 days + the saved 5
    r = await call("POST", "/admin/premium", { email: "bob@gmail.com" }, null, admin); assert.equal(r.status, 200);
    assert.equal(expiryOf("bob"), addDays(today, 30 + 5), "30 days + 5 bonus days"); assert.equal(bonusOf("bob"), 0, "the saved days are used up");
    assert.equal(r.body.account.validUntil, addDays(today, 29 + 5)); assert.equal(r.body.account.bonusDays, 0);
    r = await call("POST", "/admin/premium", { email: "bob@gmail.com" }, null, admin); assert.equal(expiryOf("bob"), addDays(today, 30 + 5), "a second purchase has no bonus left to add and never shortens the plan");
    check("reward days wait for the next Premium plan: 30 + saved days, used up once, and a Free user stays Free until then");

    // --- automatic approval ---
    setConfig((c) => { c.rewards[0].approval = "auto"; });
    const dave = await login("dave"); const d0 = expiryOf("dave");
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, dave);
    assert.equal(r.status, 200); assert.equal(r.body.status, "granted"); assert.equal(expiryOf("dave"), d0, "granted = saved, not applied"); assert.equal(bonusOf("dave"), 5); assert.equal(r.body.account.bonusDays, 5);
    const erin = await login("erin"); const e0 = expiryOf("erin");
    const many = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, erin)));
    assert.equal(many.filter((x) => x.status === 200).length, 1, "six clicks at once: one grant"); assert.equal(bonusOf("erin"), 5); assert.equal(expiryOf("erin"), e0);
    check("automatic approval saves the days at once (still not applied), and simultaneous claims count once");

    // --- referral: only right after sign-up, BOTH sides get the days, never both ways ---
    const aliceBefore = expiryOf("alice"); assert.equal(bonusOf("bob"), 0);
    const acctOf = async (tok) => (await call("GET", "/auth/me", undefined, tok)).body.account;
    assert.equal((await acctOf(bob)).refPending, true, "bob is new: the referral step is open for him");
    r = await call("POST", "/api/rewards/redeem", { code: "  " + code.toLowerCase() + " " }, bob); assert.equal(r.status, 200); assert.equal(r.body.days, 7);
    assert.equal(r.body.account.refPending, false, "the step is over for bob");
    assert.equal(expiryOf("alice"), aliceBefore, "the plan is not changed"); assert.equal(bonusOf("alice"), 5 + 7, "the owner of the code gets the 7 days saved, on top of her 5");
    assert.equal(bonusOf("bob"), 7, "the NEW user gets 7 days saved too"); assert.equal(userOf("alice").ref_pending, false, "using alice's code closed alice's own chance to enter a code");
    assert.equal((await call("GET", "/auth/me", undefined, bob)).body.account.bonusDays, 7);
    r = await call("POST", "/api/rewards/redeem", { code }, bob); assert.equal(r.status, 409); assert.equal(r.body.code, "REFERRAL_CLOSED"); assert.equal(bonusOf("alice"), 12); assert.equal(bonusOf("bob"), 7);
    const carolCode = (await call("GET", "/api/rewards", undefined, carol)).body.referral.code; const carolBefore = expiryOf("carol");
    r = await call("POST", "/api/rewards/redeem", { code: carolCode }, bob); assert.equal(r.status, 409); assert.equal(expiryOf("carol"), carolBefore); assert.equal(bonusOf("carol"), 0, "a user can use only one code");
    r = await call("POST", "/api/rewards/redeem", { code: carolCode }, carol); assert.equal(r.status, 400); assert.match(r.body.error, /own code/);
    r = await call("POST", "/api/rewards/redeem", { code: "ZZZZZZZZ" }, carol); assert.equal(r.status, 404); r = await call("POST", "/api/rewards/redeem", { code: "x" }, carol); assert.equal(r.status, 400);
    assert.equal((await acctOf(carol)).refPending, true, "refused codes do not use up carol's chance");
    r = await call("GET", "/api/rewards", undefined, alice); assert.equal(r.body.referral.referred, 1); assert.equal(r.body.referral.canRedeem, undefined, "the panel no longer offers a code box: it is a sign-up step now"); assert.equal(carolBefore, expiryOf("carol"));
    r = await call("GET", "/api/rewards", undefined, bob); assert.equal(r.body.referral.referred, 0, "bob's own record is only a receipt: it does not count as a friend he referred");
    assert.deepEqual(cols.rewards.docs.filter((d) => d.reward === "referred").map((d) => [d.email, d.days]), [["bob@gmail.com", 7]]);
    check("referral: both the owner and the new user get the days saved, once, and the step closes for the new user and for the owner of the code; bad codes and own codes are refused");

    // --- both ways is impossible (this was the loophole: two people referring each other would get 14 days each) ---
    const monaTok = await login("mona"), nickTok = await login("nick");
    r = await call("POST", "/auth/google", { idToken: pad("mona") }); assert.equal(r.body.isNewUser, false); assert.equal(r.body.account.refPending, true, "logging in again does not close the step"); assert.equal(r.body.account.refDays, 7);
    const monaCode = (await call("GET", "/api/rewards", undefined, monaTok)).body.referral.code, nickCode = (await call("GET", "/api/rewards", undefined, nickTok)).body.referral.code;
    // a) one after the other: nick uses mona's code, then mona tries nick's code
    r = await call("POST", "/api/rewards/redeem", { code: monaCode }, nickTok); assert.equal(r.status, 200); assert.equal(bonusOf("mona"), 7); assert.equal(bonusOf("nick"), 7);
    r = await call("POST", "/api/rewards/redeem", { code: nickCode }, monaTok); assert.equal(r.status, 409); assert.equal(r.body.code, "REFERRAL_CLOSED", "mona's step closed when nick used her code");
    assert.equal(bonusOf("mona"), 7); assert.equal(bonusOf("nick"), 7, "nobody got the second pair of days");
    // b) even if mona's step were somehow still open, nick's code is refused because nick joined with HER code
    userOf("mona").ref_pending = true;
    r = await call("POST", "/api/rewards/redeem", { code: nickCode }, monaTok); assert.equal(r.status, 409); assert.equal(r.body.code, "MUTUAL_REFERRAL"); assert.match(r.body.error, /one way/);
    assert.equal(bonusOf("mona"), 7); assert.equal(bonusOf("nick"), 7); assert.equal(userOf("mona").ref_pending, true, "a refused code leaves the step as it was"); userOf("mona").ref_pending = false;
    // c) a circle of three (omar <- pia <- quin <- omar): the last link is refused because omar's step closed when pia used his code
    const omarTok = await login("omar"), piaTok = await login("pia"), quinTok = await login("quin");
    const omarCode = (await call("GET", "/api/rewards", undefined, omarTok)).body.referral.code, piaCode = (await call("GET", "/api/rewards", undefined, piaTok)).body.referral.code, quinCode = (await call("GET", "/api/rewards", undefined, quinTok)).body.referral.code;
    assert.equal((await call("POST", "/api/rewards/redeem", { code: omarCode }, piaTok)).status, 200); assert.equal((await call("POST", "/api/rewards/redeem", { code: piaCode }, quinTok)).status, 200);
    r = await call("POST", "/api/rewards/redeem", { code: quinCode }, omarTok); assert.equal(r.status, 409); assert.equal(r.body.code, "REFERRAL_CLOSED");
    assert.deepEqual(["omar", "pia", "quin"].map(bonusOf), [7, 14, 7], "a chain pays each link once; the circle was not closed");
    check("referrals cannot go both ways: not one after the other, not by a stale step, not around a circle of three");

    // --- two people use each other's codes at the very same moment ---
    const ritaTok = await login("rita"), saraTok = await login("sara");
    const ritaCode = (await call("GET", "/api/rewards", undefined, ritaTok)).body.referral.code, saraCode = (await call("GET", "/api/rewards", undefined, saraTok)).body.referral.code;
    const both = await Promise.all([call("POST", "/api/rewards/redeem", { code: saraCode }, ritaTok), call("POST", "/api/rewards/redeem", { code: ritaCode }, saraTok)]);
    assert.ok(both.filter((x) => x.status === 200).length <= 1, "at most one of the two uses succeeds");
    const rs = userOf("rita"), ss = userOf("sara");
    assert.ok(!(rs.referred_by && ss.referred_by && String(rs.referred_by) === String(ss._id) && String(ss.referred_by) === String(rs._id)), "never both ways");
    assert.ok(bonusOf("rita") + bonusOf("sara") <= 14, "at most one pair of 7 days was paid");
    assert.equal(cols.rewards.docs.filter((d) => d.reward === "referral" && (d.email === "rita@gmail.com" || d.email === "sara@gmail.com")).length, both.filter((x) => x.status === 200).length, "records match what was paid");
    check("referral: two people using each other's codes at the same moment are not both paid");

    // --- skip, and old accounts ---
    const lenaTok0 = await login("lena"), janeTok0 = await login("jane");
    r = await call("POST", "/api/referral/skip"); assert.equal(r.status, 401);
    r = await call("POST", "/api/referral/skip", {}, lenaTok0); assert.equal(r.status, 200); assert.equal(r.body.account.refPending, false);
    r = await call("POST", "/api/referral/skip", {}, lenaTok0); assert.equal(r.status, 200, "skipping twice is fine"); assert.equal(userOf("lena").ref_pending, false);
    const bonusAlice = bonusOf("alice"); r = await call("POST", "/api/rewards/redeem", { code }, lenaTok0); assert.equal(r.status, 409); assert.equal(r.body.code, "REFERRAL_CLOSED", "after skipping, a code can never be used"); assert.equal(bonusOf("alice"), bonusAlice); assert.equal(bonusOf("lena"), 0);
    delete userOf("jane").ref_pending; // an account made before this feature existed
    r = await call("GET", "/auth/me", undefined, janeTok0); assert.equal(r.body.account.refPending, false, "old accounts are never asked"); r = await call("POST", "/api/rewards/redeem", { code }, janeTok0); assert.equal(r.status, 409); assert.equal(bonusOf("alice"), bonusAlice);
    check("skip closes the step for good (and is safe to press twice); accounts made before this feature are never asked and cannot use a code");

    // --- cap ---
    setConfig((c) => { c.referral.maxReferrals = 1; });
    r = await call("POST", "/api/rewards/redeem", { code }, carol); assert.equal(r.status, 409); assert.match(r.body.error, /limit/);
    assert.equal((await acctOf(carol)).refPending, true, "a refused code does not use up the friend's one try"); assert.equal(bonusOf("carol"), 0);
    setConfig((c) => { c.referral.days = 3; }); r = await call("POST", "/api/rewards/redeem", { code }, carol); assert.equal(r.status, 200); assert.equal(r.body.days, 3, "the days come from the file at the moment of the redeem"); assert.equal(bonusOf("alice"), 5 + 7 + 3);
    assert.equal(bonusOf("carol"), 3, "the new user gets the same 3 days");
    check("maxReferrals caps the payouts to one owner, and the days (for both sides) are read from rewards.json each time");
    // --- "apply": "now": the days go onto the CURRENT plan at once (not saved for the next Premium) ---
    setConfig((c) => { c.rewards[0].days = 3; c.rewards[0].apply = "now"; });
    r = await call("GET", "/api/rewards", undefined, alice); assert.equal(r.body.rewards.find((x) => x.id === "review").apply, "now"); assert.equal(r.body.rewards.find((x) => x.id === "instagram").apply, "next_premium");
    const frank = await login("frank"); const f0 = expiryOf("frank"); assert.ok(!(today < f0), "frank starts on the Free plan (no free days at signup)");
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, frank); assert.equal(r.body.status, "pending"); assert.equal(r.body.apply, "now"); assert.equal(expiryOf("frank"), f0, "manual: nothing before the approval");
    r = await call("POST", "/admin/rewards/decide", { email: "frank@gmail.com", reward: "review", approve: true }, null, admin); assert.equal(r.body.status, "granted"); assert.equal(r.body.apply, "now");
    assert.equal(expiryOf("frank"), addDays(today, 3), "3 days from today (an expired plan restarts today)"); assert.equal(bonusOf("frank"), 0, "nothing is saved for the next Premium");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: P("instagram") }, frank); await call("POST", "/admin/rewards/decide", { email: "frank@gmail.com", reward: "instagram", approve: true }, null, admin);
    assert.equal(expiryOf("frank"), addDays(f0, 3), "Instagram is still saved for the next Premium"); assert.equal(bonusOf("frank"), 5);
    check("apply now: the review's 3 days go onto the current plan after the approval, while Instagram is still saved for the next Premium");

    // an expired plan restarts today; automatic approval; simultaneous clicks
    setConfig((c) => { c.rewards[0].days = 3; c.rewards[0].apply = "now"; c.rewards[0].approval = "auto"; });
    const gina = await login("gina"); today = addDays(today, 30); assert.ok(!(today < expiryOf("gina")));
    const many2 = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/api/rewards/claim", { id: "review", proof: P("review") }, gina)));
    assert.equal(many2.filter((x) => x.status === 200).length, 1, "six clicks at once: one grant");
    assert.equal(expiryOf("gina"), addDays(today, 3), "expired plan: 3 days starting today"); r = await call("GET", "/auth/me", undefined, gina);
    assert.equal(r.body.account.active, true, "the user is Premium straight away"); assert.equal(r.body.account.validUntil, addDays(today, 2)); assert.equal(bonusOf("gina"), 0);
    check("apply now with automatic approval: an expired plan restarts today for 3 days, simultaneous claims count once");

    // referral with apply now: BOTH sides get the days added to their current plan
    setConfig((c) => { c.referral.apply = "now"; c.referral.days = 7; });
    const frankCode = (await call("GET", "/api/rewards", undefined, frank)).body.referral.code; const hank = await login("hank");
    const fBefore = expiryOf("frank"), fBonus = bonusOf("frank"), h0 = expiryOf("hank");
    r = await call("POST", "/api/rewards/redeem", { code: frankCode }, hank); assert.equal(r.status, 200); assert.equal(r.body.apply, "now");
    assert.equal(expiryOf("frank") >= addDays(today, 7), true); assert.equal(bonusOf("frank"), fBonus, "referral with apply now adds to the plan, not to the saved days");
    assert.equal(expiryOf("hank"), addDays(h0, 7), "the new user's 7 days are added to his plan at once"); assert.equal(bonusOf("hank"), 0);
    check("referral can use apply now too (for both sides)");

    // --- proof: the claim must say WHICH review / post, it is saved for the developer, and it can be used once ---
    setConfig(() => {}); // back to the base file (manual approval, next_premium for review, proof required)
    const ivanTok = await login("ivan"); const janeTok = await login("jane");
    r = await call("GET", "/api/rewards", undefined, ivanTok); assert.deepEqual(r.body.rewards.map((x) => [x.id, x.proof.type]), [["review", "text"], ["instagram", "instagram_post"]]); assert.equal(r.body.rewards[1].proof.label, "Post link");
    r = await call("POST", "/api/rewards/claim", { id: "instagram" }, ivanTok); assert.equal(r.status, 400); assert.equal(r.body.code, "BAD_PROOF"); assert.match(r.body.error, /proof/i, "no proof: refused");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "@myhandle" }, ivanTok); assert.equal(r.status, 400); assert.match(r.body.error, /link of your Instagram post/);
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://www.instagram.com/someone/" }, ivanTok); assert.equal(r.status, 400, "a profile link is not a post link");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://evil.example/p/ABCDE12345/" }, ivanTok); assert.equal(r.status, 400, "only instagram.com links");
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: "ab" }, ivanTok); assert.equal(r.status, 400); r = await call("POST", "/api/rewards/claim", { id: "review", proof: "x".repeat(101) }, ivanTok); assert.equal(r.status, 400);
    assert.equal(cols.rewards.docs.filter((d) => d.user_id && String(d.user_id) === String(userOf("ivan")._id)).length, 0, "a refused proof leaves no claim behind");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://instagram.com/ivanTok.k/reel/CxYz12345/?igsh=abc#top" }, ivanTok); assert.equal(r.status, 200); assert.equal(r.body.status, "pending");
    // the same post cannot be used by another account (whatever the spelling of the link), the same user cannot claim twice
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://www.instagram.com/reel/CxYz12345" }, janeTok); assert.equal(r.status, 409); assert.equal(r.body.code, "PROOF_USED");
    assert.equal(cols.rewards.docs.find((d) => d.email === "jane@gmail.com" && d.reward === "instagram"), undefined, "the refused claim of the second account leaves nothing behind");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://www.instagram.com/p/Another12345/" }, ivanTok); assert.equal(r.status, 409); assert.equal(r.body.code, "ALREADY_CLAIMED");
    assert.equal(cols.rewards.docs.filter((d) => d.key && d.key.startsWith("proof:instagram:")).filter((d) => d.key.includes("Another12345")).length, 0, "a second try by the same user does not use up another post");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://www.instagram.com/p/Zz999999/" }, janeTok); assert.equal(r.status, 200, "another post, another account: fine");
    // review names: the same name (any capitals or spaces) cannot be used twice
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: "  Prakash   Dutta " }, ivanTok); assert.equal(r.status, 200);
    r = await call("POST", "/api/rewards/claim", { id: "review", proof: "prakash dutta" }, janeTok); assert.equal(r.status, 409); assert.equal(r.body.code, "PROOF_USED");
    // what the developer sees before approving
    r = await call("GET", "/admin/rewards/pending", undefined, null, admin);
    const g = r.body.pending.filter((p) => p.email === "ivan@gmail.com"); assert.deepEqual(g.map((p) => [p.reward, p.proof]).sort(), [["instagram", "https://www.instagram.com/reel/CxYz12345/"], ["review", "Prakash Dutta"]].sort());
    assert.equal(g.find((p) => p.reward === "instagram").link, "https://www.instagram.com/reel/CxYz12345/");
    r = await call("POST", "/admin/rewards/decide", { email: "ivan@gmail.com", reward: "instagram", approve: false }, null, admin); assert.equal(r.body.proof, "https://www.instagram.com/reel/CxYz12345/");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "https://www.instagram.com/reel/CxYz12345/" }, janeTok); assert.equal(r.status, 409, "a rejected proof stays used: it cannot be recycled by another account");
    check("proof: required, format-checked, saved and shown to the developer, usable once per reward (any spelling), refused claims leave nothing behind");

    // --- "instagram" accepts a username or a link; proof can be switched off per reward ---
    setConfig((c) => { c.rewards[1].proof = { type: "instagram" }; c.rewards[0].proof = { required: false }; });
    const kate = await login("kate");
    r = await call("GET", "/api/rewards", undefined, kate); assert.equal(r.body.rewards[0].proof, null, "required: false = the popup asks for nothing"); assert.equal(r.body.rewards[1].proof.type, "instagram");
    r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "@Kate.Reads" }, kate); assert.equal(r.status, 200);
    r = await call("GET", "/admin/rewards/pending", undefined, null, admin); const kp = r.body.pending.find((p) => p.email === "kate@gmail.com"); assert.equal(kp.proof, "@Kate.Reads"); assert.equal(kp.link, "https://www.instagram.com/Kate.Reads/");
    const lenaTok = await login("lena"); r = await call("POST", "/api/rewards/claim", { id: "instagram", proof: "kate.reads" }, lenaTok); assert.equal(r.status, 409, "the same username with other capitals or without @ is the same proof"); assert.equal(r.body.code, "PROOF_USED");
    r = await call("POST", "/api/rewards/claim", { id: "review" }, kate); assert.equal(r.status, 200, "no proof needed when the developer turned it off"); assert.equal(r.body.status, "pending");
    check("instagram accepts a username or a link, and a reward can be set to need no proof");

    // --- the exact simultaneous case, forced: tina's claim and uma's claim both land before either looks at the other ---
    setConfig(() => {});
    const { createDb } = require("./db"); const { createRewards } = require("./rewards");
    const rdb = createDb({ users: cols.users, histories: cols.histories, dictionary: cols.dictionary, counters: cols.counters, jobs: cols.jobs, articles: cols.articles, payments: cols.payments, rewards: cols.rewards, today: () => today });
    await login("tina"); await login("uma"); const tina = userOf("tina"), uma = userOf("uma"); const codeT = await rdb.getRefCode(tina), codeU = await rdb.getRefCode(uma);
    const racing = { ...rdb, claimReferral: async (uid, oid) => { const ok = await rdb.claimReferral(uid, oid); if (String(uid) === String(tina._id)) await rdb.claimReferral(uma._id, tina._id); return ok; } }; // uma's use of tina's code lands right after tina's claim
    await assert.rejects(createRewards({ db: racing }).redeem(tina, codeU), (e) => e.code === "MUTUAL_REFERRAL");
    assert.equal(userOf("tina").ref_pending, true, "the request that noticed undid its own claim"); assert.ok(!userOf("tina").referred_by); assert.equal(bonusOf("tina"), 0); assert.equal(bonusOf("uma"), 0, "nobody was paid");
    assert.equal(cols.rewards.docs.filter((d) => d.email === "tina@gmail.com" || d.email === "uma@gmail.com").length, 0, "no reward records were written");
    check("referral: a mutual use that slips past the first check is noticed after the claim and undone, nobody is paid");

    // --- different days for the two sides: the new user gets `days`, the code's owner gets `ownerDays` per friend; the cap counts friends ---
    setConfig((c) => { c.referral.days = 7; c.referral.ownerDays = 3; c.referral.apply = "next_premium"; c.referral.maxReferrals = 2; });
    const wilToken = await login("wil"); const wilCode = (await call("GET", "/api/rewards", undefined, wilToken)).body.referral.code;
    r = await call("GET", "/api/rewards", undefined, wilToken); assert.equal(r.body.referral.days, 7); assert.equal(r.body.referral.ownerDays, 3);
    const wilBefore = bonusOf("wil"); const friends = [];
    for (const n of ["xia", "yan", "zed"]) friends.push([n, await login(n)]);
    r = await call("GET", "/auth/me", undefined, friends[0][1]); assert.equal(r.body.account.refDays, 7); assert.equal(r.body.account.refOwnerDays, 3);
    for (const [n, tok] of friends.slice(0, 2)) {
      r = await call("POST", "/api/rewards/redeem", { code: wilCode }, tok); assert.equal(r.status, 200); assert.equal(r.body.days, 7); assert.equal(r.body.ownerDays, 3);
      assert.equal(bonusOf(n), 7, "the new user gets 7 days");
    }
    assert.equal(bonusOf("wil"), wilBefore + 6, "the owner gets 3 days for each of the 2 friends");
    r = await call("POST", "/api/rewards/redeem", { code: wilCode }, friends[2][1]); assert.equal(r.status, 409); assert.match(r.body.error, /limit/);
    assert.equal(bonusOf("wil"), wilBefore + 6, "no days after the cap"); assert.equal(bonusOf("zed"), 0);
    setConfig((c) => { c.referral.days = 7; delete c.referral.ownerDays; });
    r = await call("GET", "/api/rewards", undefined, wilToken); assert.equal(r.body.referral.ownerDays, 7, "ownerDays left out = the same as days");
    check("referral: the new user gets `days`, the owner gets `ownerDays` per friend, and the cap stops further payouts");

    console.log("\nAll rewards tests passed.");
    process.exit(0);
  } catch (e) { console.error("FAILED:", e); process.exit(1); }
})();
