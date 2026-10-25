// Google sign-in verification and signed session tokens (accounts are stored in db.js). Zero dependencies (Node 18+).
const crypto = require("crypto");

const b64u = (x) => Buffer.from(x).toString("base64url");

function createAuth({ clientId, secret, tokeninfoUrl, db, sessionDays }) {
  const TOKENINFO = tokeninfoUrl || "https://oauth2.googleapis.com/tokeninfo";
  const SESSION_MS = (sessionDays || 7) * 24 * 3600 * 1000;

  // Accounts live in the database (see db.js), keyed by the verified Gmail address.
  // ---- Google ID token verification ----
  // Google's tokeninfo endpoint checks the token's signature and expiry for us.
  // We then check that the token was issued for OUR client id and that the e-mail is verified.
  async function verifyGoogleIdToken(idToken) {
    if (!clientId) { const e = new Error("The backend has no GOOGLE_CLIENT_ID configured."); e.status = 503; throw e; }
    if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) { const e = new Error("Missing Google token."); e.status = 400; throw e; }
    let res;
    try { res = await fetch(TOKENINFO + "?id_token=" + encodeURIComponent(idToken)); }
    catch (err) { const e = new Error("Could not reach Google to verify your sign-in. Try again."); e.status = 502; throw e; }
    const c = await res.json().catch(() => ({}));
    const bad = (msg) => { const e = new Error(msg || "Google sign-in could not be verified."); e.status = 401; return e; };
    if (!res.ok) throw bad();
    if (c.aud !== clientId) throw bad("This Google token was not issued for NewsVocab.");
    if (c.iss !== "accounts.google.com" && c.iss !== "https://accounts.google.com") throw bad();
    if (Number(c.exp) * 1000 < Date.now()) throw bad("The Google sign-in has expired. Try again.");
    if (!(c.email_verified === true || c.email_verified === "true")) throw bad("Your Google email address is not verified.");
    if (!c.sub || !c.email) throw bad();
    return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: c.name || "", picture: c.picture || "", nonce: c.nonce };
  }

  // ---- our own signed session token: base64url(payload).base64url(HMAC-SHA256) ----
  const sign = (body) => crypto.createHmac("sha256", secret).update(body).digest("base64url");
  function issueSession(user) {
    const body = b64u(JSON.stringify({ email: user.email, exp: Date.now() + SESSION_MS }));
    return body + "." + sign(body);
  }
  async function readSession(token) {
    if (typeof token !== "string") return null;
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return null;
    const expected = sign(body);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!p || typeof p.email !== "string" || !(p.exp > Date.now())) return null;
    return db.getUser(p.email); // null if the account no longer exists
  }
  const userFromRequest = async (req) => readSession(((req.headers.authorization || "").match(/^Bearer (.+)$/) || [])[1]);

  const publicUser = (u) => ({ email: u.email });

  return { verifyGoogleIdToken, issueSession, readSession, userFromRequest, publicUser };
}

module.exports = { createAuth };
