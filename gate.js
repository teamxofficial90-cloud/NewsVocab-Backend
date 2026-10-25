// A gate in front of the Gemini API: at most `concurrency` calls run at once, up to `queueSize` more wait in a first-in-first-out line,
// and anything beyond that is turned away at once. Waiting requests get an estimate of the seconds left, based on how long recent
// Gemini calls really took. Everything is in memory: with several backend instances each one has its own gate.
function createGate({ concurrency = 30, queueSize = 100, maxWaitMs = 90000, initialAvgMs = 10000, now = Date.now } = {}) {
  let active = 0;
  let avgMs = initialAvgMs;          // moving average of how long one run takes
  const waiting = [];                // tickets in line, oldest first
  const byKey = new Map();           // key -> ticket (waiting or running), so a status request can find its own ticket

  const isFull = () => active >= concurrency && waiting.length >= queueSize;

  // Seconds until the work of a ticket is probably finished. Position p in the line starts after about p * avg / concurrency
  // (a slot frees up that often when `concurrency` runs overlap), and then needs one run of its own.
  function etaOf(t) {
    const avg = avgMs / 1000;
    let s;
    if (t.state === "running") s = Math.max(2, avg - (now() - t.startedAt) / 1000);
    else s = ((waiting.indexOf(t) + 1) * avg) / concurrency + avg;
    return Math.ceil(s * 1.15); // a small margin: a countdown that ends early is better than one that ends late
  }

  function status(key) {
    const t = byKey.get(key);
    if (!t) return { state: "none" };
    return { state: t.state, position: t.state === "waiting" ? waiting.indexOf(t) + 1 : 0, etaSeconds: etaOf(t) };
  }

  function startNext() {
    while (active < concurrency && waiting.length > 0) {
      const t = waiting.shift();
      clearTimeout(t.timer);
      active++;
      t.state = "running"; t.startedAt = now();
      t.start();
    }
  }

  // Runs fn() as soon as a slot is free. Rejects at once with { code: "QUEUE_FULL" } if the line is full, and with
  // { code: "QUEUE_TIMEOUT" } if the wait exceeds maxWaitMs. `key` (optional) lets status(key) find this request.
  function run(fn, key) {
    return new Promise((resolve, reject) => {
      if (isFull()) { const e = new Error("Queue is full."); e.code = "QUEUE_FULL"; return reject(e); }
      const t = { key, state: "waiting", startedAt: 0, timer: null, start: null };
      const finish = () => { active--; if (key !== undefined && byKey.get(key) === t) byKey.delete(key); startNext(); };
      t.start = () => {
        Promise.resolve().then(fn).then(
          (v) => { avgMs = 0.8 * avgMs + 0.2 * (now() - t.startedAt); finish(); resolve(v); }, // only successful runs update the estimate
          (e) => { finish(); reject(e); }
        );
      };
      if (key !== undefined) byKey.set(key, t);
      if (active < concurrency) { active++; t.state = "running"; t.startedAt = now(); t.start(); return; }
      waiting.push(t);
      t.timer = setTimeout(() => {
        const i = waiting.indexOf(t);
        if (i === -1) return;
        waiting.splice(i, 1);
        if (key !== undefined && byKey.get(key) === t) byKey.delete(key);
        const e = new Error("Waited too long in the queue."); e.code = "QUEUE_TIMEOUT"; reject(e);
      }, maxWaitMs);
    });
  }

  return { run, status, isFull, stats: () => ({ active, waiting: waiting.length, avgSeconds: avgMs / 1000 }) };
}

module.exports = { createGate };
