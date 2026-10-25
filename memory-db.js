// In-memory stand-in for the four MongoDB collections. It supports only what db.js uses (findOne, find().toArray() with
// {_id: {$in}}, insertOne, insertMany (unordered, duplicates are reported like MongoDB does), updateOne with
// $set / $addToSet+$each / $unset, unique fields). Used by the tests and by NEWSVOCAB_DB=memory for a quick
// trial run. Everything is lost when the process stops, so never use it for real users.
const same = (a, b) => (a == null && b == null) || a === b;
const matches = (doc, filter) => Object.keys(filter).every((k) => same(doc[k], filter[k]));

class MemoryCollection {
  constructor(unique = []) { this.docs = []; this.unique = unique; this.seq = 0; }
  // Only the filter shapes db.js uses: { field: { $in: [...] } } (field is _id or w). Returns an object with toArray(), like a MongoDB cursor.
  find(filter) {
    const key = filter && Object.keys(filter)[0];
    const list = key && filter[key] && filter[key].$in;
    // { field: { $in } } as above, or plain equality on every field ({ user_id, status }), or no filter at all.
    const docs = this.docs.filter((x) => (list ? list.includes(x[key]) : matches(x, filter || {}))).map((x) => structuredClone(x));
    return { toArray: async () => docs };
  }
  // Documents may bring their own _id. Unordered: a duplicate (same _id or same value in a unique field) does not stop the others,
  // and the failure is reported afterwards the way the MongoDB driver does (code 11000, writeErrors).
  async insertMany(docs) {
    const writeErrors = [];
    for (const doc of docs) {
      const clash = (doc._id !== undefined && this.docs.some((x) => x._id === doc._id)) ||
        this.unique.some((k) => doc[k] !== undefined && this.docs.some((x) => x[k] === doc[k]));
      if (clash) { writeErrors.push({ code: 11000 }); continue; }
      this.docs.push({ ...structuredClone(doc), _id: doc._id !== undefined ? doc._id : "id" + (++this.seq) });
    }
    if (writeErrors.length) { const e = new Error("E11000 duplicate key"); e.code = 11000; e.writeErrors = writeErrors; throw e; }
    return { insertedCount: docs.length };
  }
  async deleteMany(filter) {
    const list = filter && filter._id && filter._id.$in;
    const before = this.docs.length;
    this.docs = this.docs.filter((x) => !(list && list.includes(x._id)));
    return { deletedCount: before - this.docs.length };
  }
  // Only what the jobs collection needs: replace the first matching document (same _id), and delete one.
  async replaceOne(filter, doc) {
    const i = this.docs.findIndex((x) => matches(x, filter));
    if (i < 0) return { matchedCount: 0, modifiedCount: 0 };
    this.docs[i] = { ...structuredClone(doc), _id: this.docs[i]._id };
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async deleteOne(filter) {
    const i = this.docs.findIndex((x) => matches(x, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
  async findOne(filter) { const d = this.docs.find((x) => matches(x, filter)); return d ? structuredClone(d) : null; }
  async insertOne(doc) {
    for (const k of this.unique) {
      if (this.docs.some((x) => same(x[k], doc[k]))) { const e = new Error("E11000 duplicate key on " + k); e.code = 11000; throw e; }
    }
    const _id = "id" + (++this.seq);
    this.docs.push({ ...structuredClone(doc), _id });
    return { insertedId: _id };
  }
  async updateOne(filter, update) {
    const d = this.docs.find((x) => matches(x, filter));
    if (!d) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(d, structuredClone(update.$set));
    for (const [k, v] of Object.entries(update.$addToSet || {})) {
      d[k] = d[k] || [];
      for (const x of structuredClone(v.$each)) if (!d[k].includes(x)) d[k].push(x);
    }
    for (const k of Object.keys(update.$unset || {})) delete d[k];
    return { matchedCount: 1, modifiedCount: 1 };
  }
  // Only what db.js uses: { $inc } with upsert, returning the document after the change (the counter of word numbers).
  async findOneAndUpdate(filter, update, opts = {}) {
    let d = this.docs.find((x) => matches(x, filter));
    if (!d) { if (!opts.upsert) return null; d = { ...structuredClone(filter) }; this.docs.push(d); }
    for (const [k, v] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + v;
    return structuredClone(d);
  }
}

function createMemoryCollections() {
  return { users: new MemoryCollection(["email"]), histories: new MemoryCollection(["user_id"]), dictionary: new MemoryCollection(["w"]), counters: new MemoryCollection(), jobs: new MemoryCollection(["user_id"]), articles: new MemoryCollection(["h"]), payments: new MemoryCollection(["pid"]), rewards: new MemoryCollection(["key"]), close: async () => {}, drop: async () => {} };
}

module.exports = { createMemoryCollections };
