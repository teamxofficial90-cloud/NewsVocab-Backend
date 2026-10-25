// Packs a list of word numbers into bytes and back: 3 bytes per number (big-endian), so a history of 1,000 words is 3,000 bytes.
// 3 bytes hold numbers up to 16,777,215, far more than the ~600,000 words of English.
const WIDTH = 3, MAX_ID = 0xFFFFFF;

function pack(ids) {
  const buf = Buffer.alloc(ids.length * WIDTH);
  for (let i = 0; i < ids.length; i++) {
    const n = ids[i];
    if (!Number.isInteger(n) || n < 1 || n > MAX_ID) throw new Error("Word number out of range: " + n);
    const o = i * WIDTH;
    buf[o] = (n >>> 16) & 255; buf[o + 1] = (n >>> 8) & 255; buf[o + 2] = n & 255;
  }
  return buf;
}

// Accepts a Buffer / Uint8Array, or a MongoDB Binary (its bytes are in .buffer, the used length in .position).
function toBytes(x) {
  if (!x) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x.buffer instanceof Uint8Array) return typeof x.position === "number" ? x.buffer.subarray(0, x.position) : x.buffer;
  return new Uint8Array(0);
}

function unpack(x) {
  const b = toBytes(x); const n = Math.floor(b.length / WIDTH); const ids = new Array(n);
  for (let i = 0; i < n; i++) { const o = i * WIDTH; ids[i] = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; }
  return ids;
}

module.exports = { pack, unpack, WIDTH, MAX_ID };
