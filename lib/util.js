// Shared helpers (ES module, used by worker.js, popup.js, deep.js)
export const JS_CT = /javascript|ecmascript|jscript|\/x?-?js\b/i;
export const JS_EXT = /\.(m|c)?js(\?|#|$)/i;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SENS = /(token|secret|passw|pwd|auth|sess|sig|key|jwt|bearer|cred|otp|csrf|xsrf|mail|code|hash|policy|nonce|ticket)/i;

/** Remove credentials, fragments and sensitive-looking query values. */
export function sanitizeUrl(u) {
  try {
    if (typeof u !== 'string') return { url: u, redacted: false };
    if (u.startsWith('data:')) {
      const i = u.indexOf(',');
      return { url: u.slice(0, Math.min(i < 0 ? 40 : i, 60)) + ',[data: ' + u.length + ' chars]', redacted: true };
    }
    const x = new URL(u);
    let red = false;
    if (x.username || x.password) { x.username = ''; x.password = ''; red = true; }
    if (x.hash) { x.hash = ''; red = true; }
    if (x.search) {
      const q = x.search.slice(1).split('&').map((p) => {
        const i = p.indexOf('=');
        if (i < 0) return p;
        const k = p.slice(0, i), v = p.slice(i + 1);
        let dk = k; try { dk = decodeURIComponent(k); } catch {}
        if (SENS.test(dk) || (v.length >= 32 && /^[A-Za-z0-9_\-+/=.%~]+$/.test(v))) { red = true; return k + '=[REDACTED]'; }
        return p;
      });
      x.search = q.join('&');
    }
    return { url: x.href, redacted: red };
  } catch {
    return { url: String(u).slice(0, 300), redacted: false };
  }
}
export const san = (u) => sanitizeUrl(u).url;

export function stripHash(u) {
  try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; }
}
export function originOf(u) { try { return new URL(u).origin; } catch { return null; } }
export function hostOf(u) {
  try { return new URL(u.startsWith('blob:') ? u.slice(5) : u).hostname; } catch { return ''; }
}

const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
/** Approximate registrable domain (no public-suffix list; heuristic). */
export function registrable(h) {
  if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const p = h.split('.');
  if (p.length >= 3 && SLD.has(p[p.length - 2]) && p[p.length - 1].length === 2) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}
export const isThirdParty = (url, topHost) => registrable(hostOf(url)) !== registrable(topHost);

export function safeName(s, max = 60) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._]+|[._]+$/g, '').slice(0, max) || 'file';
}
export function fileBase(url) {
  try {
    const x = new URL(url.startsWith('blob:') ? url.slice(5) : url);
    let b = x.pathname.split('/').filter(Boolean).pop() || 'index';
    try { b = decodeURIComponent(b); } catch {}
    return b;
  } catch { return 'resource'; }
}
export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const bytesToText = (b) => new TextDecoder('utf-8', { fatal: false }).decode(b);

/** Run fn over items with a concurrency limit. Errors are logged, never thrown. */
export async function pool(items, limit, fn) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { console.error('pool task failed', e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// ---- IndexedDB hand-off of the finished ZIP between worker page and popup ----
function openDb() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('aafc', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('zips');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
export async function saveZip(blob, meta) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction('zips', 'readwrite');
    tx.objectStore('zips').put({ blob, ...meta }, 'latest');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}
export async function loadZip() {
  const db = await openDb();
  const v = await new Promise((res, rej) => {
    const r = db.transaction('zips').objectStore('zips').get('latest');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  db.close();
  return v || null;
}
