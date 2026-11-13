// Minimal ZIP writer (STORE or DEFLATE via CompressionStream). No ZIP64: <4 GiB, <65535 entries.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function deflateRaw(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(u8).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch { return null; }
}
export class ZipWriter {
  constructor() { this.parts = []; this.cd = []; this.offset = 0; this.n = 0; this.enc = new TextEncoder(); this.names = new Set(); }
  async add(name, data, opt = {}) {
    if (this.names.has(name)) throw new Error('duplicate zip entry: ' + name);
    this.names.add(name);
    const u8 = typeof data === 'string' ? this.enc.encode(data) : data;
    const nameB = this.enc.encode(name);
    const crc = crc32(u8);
    let method = 0, body = u8;
    if (opt.compress !== false && u8.length > 128) {
      const d = await deflateRaw(u8);
      if (d && d.length < u8.length) { method = 8; body = d; }
    }
    const dt = opt.date || new Date();
    const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
    const date = (Math.max(0, dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, method, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, u8.length, true);
    h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(h.buffer), nameB, body);
    this.cd.push({ nameB, crc, method, time, date, csize: body.length, usize: u8.length, off: this.offset });
    this.offset += 30 + nameB.length + body.length;
    this.n++;
    if (this.offset > 0xFFFF0000 || this.n >= 0xFFFF) throw new Error('ZIP limit exceeded (no ZIP64 support)');
  }
  finish() {
    const cdParts = []; let cdSize = 0;
    for (const e of this.cd) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true);
      h.setUint16(10, e.method, true); h.setUint16(12, e.time, true); h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true); h.setUint32(20, e.csize, true); h.setUint32(24, e.usize, true);
      h.setUint16(28, e.nameB.length, true); h.setUint16(30, 0, true); h.setUint16(32, 0, true);
      h.setUint16(34, 0, true); h.setUint16(36, 0, true); h.setUint32(38, 0, true); h.setUint32(42, e.off, true);
      cdParts.push(new Uint8Array(h.buffer), e.nameB); cdSize += 46 + e.nameB.length;
    }
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(4, 0, true); eo.setUint16(6, 0, true);
    eo.setUint16(8, this.n, true); eo.setUint16(10, this.n, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, this.offset, true); eo.setUint16(20, 0, true);
    const blob = new Blob([...this.parts, ...cdParts, new Uint8Array(eo.buffer)], { type: 'application/zip' });
    this.parts = []; this.cd = [];
    return blob;
  }
}
