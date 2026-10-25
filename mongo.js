// Connects to MongoDB and returns the collections db.js works with.
async function connect({ uri, dbName }) {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); }
  catch (e) { throw new Error("The \"mongodb\" package is not installed. Run:  cd backend && npm install"); }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, promoteBuffers: true }) // promoteBuffers: packed binary fields come back as plain Buffers;
  try { await client.connect(); }
  catch (e) { throw new Error("Cannot connect to MongoDB (" + e.message + "). Check MONGODB_URI and that your IP is allowed in MongoDB Atlas > Network Access."); }
  const database = client.db(dbName || "newsvocab");
  const users = database.collection("users");
  const histories = database.collection("histories");
  const dictionary = database.collection("dictionary");           // one document per word, shared by all users; _id is the word's permanent number
  const counters = database.collection("counters");               // { _id: "dictionary", seq }: the last word number handed out
  const jobs = database.collection("jobs");                       // one document per user: the latest generation request and, once finished, its result (deleted by MongoDB after expires_at)
  const articles = database.collection("articles");               // one document per article read recently: the candidate words Gemini chose for it, shared by all users (deleted by MongoDB after expires_at)
  const payments = database.collection("payments");               // one document per Razorpay payment link created for a user (kept as the payment record; see premium.js)
  const rewards = database.collection("rewards");                 // free-days rewards claimed by users (see rewards.js)
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ ref_code: 1 }, { sparse: true });             // find the owner of a referral code
  await rewards.createIndex({ key: 1 }, { unique: true });                // a reward counts once per user (or once per referred friend)
  await rewards.createIndex({ user_id: 1 });
  await rewards.createIndex({ status: 1 });      // one account per Gmail address
  await histories.createIndex({ user_id: 1 }, { unique: true }); // one history document per user
  await dictionary.createIndex({ w: 1 }, { unique: true, sparse: true }); // a word has exactly one number (sparse: documents of the old format have no `w`)
  await jobs.createIndex({ user_id: 1 }, { unique: true });             // at most one request per user at a time
  await jobs.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); // MongoDB removes a document once its expires_at has passed
  await articles.createIndex({ h: 1 }, { unique: true });                 // one document per article hash
  await articles.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); // MongoDB removes it once expires_at has passed
  await payments.createIndex({ pid: 1 }, { unique: true });               // one document per payment link
  await payments.createIndex({ user_id: 1, status: 1 });                  // the links of a user that are not used yet
  return { users, histories, dictionary, counters, jobs, articles, payments, rewards, close: () => client.close(), drop: () => database.dropDatabase() };
}

module.exports = { connect };
