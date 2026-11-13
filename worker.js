// Orchestrator. Runs in its own extension tab so it survives the popup closing.
import { sleep, san, sanitizeUrl, stripHash, originOf, hostOf, safeName, fileBase, sha256Hex, b64ToBytes, bytesToText, pool, JS_CT, JS_EXT, registrable, isThirdParty, saveZip } from './lib/util.js';
import { ZipWriter } from './lib/zip.js';
import { collectInFrame, fetchInPage, dumpHook } from './lib/page-funcs.js';
import { DeepCapture } from './lib/deep.js';

const Q = new URLSearchParams(location.search);
const tabId = Number(Q.get('tabId'));
const mode = Q.get('mode') === 'reload' ? 'reload' : 'current';
const deep = Q.get('deep') === '1';
const VERSION = '1.0.0';
const MAX_FILE = 15 * 1024 * 1024, MAX_TOTAL = 250 * 1024 * 1024, CONC = 6, SETTLE_MS = 5000;
const logEl = document.getElementById('log');
const job = { state: 'running', tabId, mode, deep, phase: 'Starting', pct: 0, discovered: 0, inline: 0, downloaded: 0, failed: 0, skipped: 0, startedAt: Date.now() };

const ui = (m) => { const d = document.createElement('div'); d.textContent = new Date().toLocaleTimeString() + '  ' + m; logEl.appendChild(d); };
async function setJob(p) { Object.assign(job, p); try { await chrome.storage.session.set({ job }); } catch {} }
async function phase(msg, pct) { ui(msg); await setJob({ phase: msg, pct }); }
const pad = (n, w) => String(n).padStart(w, '0');

let frames = [], hookDumps = [], netLog = null, deepData = null, totalBytes = 0;
const R = new Map();

// ------------------------------------------------------------------ resource table
function addRes(url, patch = {}) {
  if (typeof url !== 'string' || !/^(https?:|blob:|data:)/i.test(url)) return null;
  const isData = url.startsWith('data:');
  const k = isData ? 'data:' + url.length + ':' + url.slice(-40) : stripHash(url);
  let r = R.get(k);
  if (!r) {
    r = { id: R.size + 1, url: isData ? url : stripHash(url), kind: 'script', definite: false, jsLikely: false, nonGet: false, via: new Set(), frames: new Set(), net: [], attempts: [], warnings: [], initiators: [], state: 'pending' };
    R.set(k, r);
  }
  if (patch.via) r.via.add(patch.via);
  if (patch.frameId != null) { r.frames.add(patch.frameId); if (r.frameId == null) r.frameId = patch.frameId; }
  if (patch.definite) r.definite = true;
  if (patch.jsLikely) r.jsLikely = true;
  if (patch.kind && (patch.force || r.kind === 'script')) r.kind = patch.kind;
  if (patch.attrs && !r.attrs) r.attrs = patch.attrs;
  if (patch.perf && !r.perf) r.perf = patch.perf;
  return r;
}

// ------------------------------------------------------------------ page-level steps
async function registerHook(url) {
  const host = new URL(url).hostname, base = registrable(host);
  const m = base === host ? [`*://${host}/*`] : [`*://${base}/*`, `*://*.${base}/*`];
  try { await chrome.scripting.unregisterContentScripts({ ids: ['aafc-hook'] }); } catch {}
  await chrome.scripting.registerContentScripts([{ id: 'aafc-hook', js: ['content/hook.js'], matches: m, runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: false }]);
  return true;
}
function reloadAndWait() {
  return new Promise((resolve, reject) => {
    let started = false, done = false;
    const fin = (why) => { if (done) return; done = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(why); };
    const to = setTimeout(() => fin('timeout after 60 s'), 60000);
    const l = (id, ci) => { if (id !== tabId) return; if (ci.status === 'loading') started = true; if (ci.status === 'complete' && started) fin('complete'); };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.reload(tabId, { bypassCache: true }).catch((e) => { if (!done) { done = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); reject(e); } });
  });
}
async function collectFrames() {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectInFrame });
  return res.filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, ...r.result })).sort((a, b) => a.frameId - b.frameId);
}
async function dumpHooks() {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: dumpHook });
  return res.filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
}

// ------------------------------------------------------------------ retrieval
const pickHeaders = (h) => { const o = {}; for (const k of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'last-modified', 'etag', 'x-content-type-options']) { const v = h.get(k); if (v) o[k] = v; } return o; };

async function execFetch(frameId, url) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fetchInPage, args: [url, MAX_FILE] });
    const x = r && r[0] && r[0].result;
    if (!x) return { ok: false, threw: true, error: 'no result from frame' };
    if (x.b64 != null) x.bytes = b64ToBytes(x.b64);
    delete x.b64; return x;
  } catch (e) { return { ok: false, threw: true, error: String((e && e.message) || e) }; }
}
async function extFetch(url) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'force-cache', redirect: 'follow', signal: ctrl.signal });
    const headers = pickHeaders(r.headers);
    const base = { ok: r.ok, status: r.status, headers, finalUrl: r.url, redirected: r.redirected };
    const cl = Number(headers['content-length']);
    if (cl > MAX_FILE) { ctrl.abort(); return { ...base, ok: false, reason: 'too-large (content-length ' + cl + ')' }; }
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.length;
      if (n > MAX_FILE) { ctrl.abort(); return { ...base, ok: false, reason: 'too-large (> ' + MAX_FILE + ' bytes)' }; }
      chunks.push(value);
    }
    const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    return { ...base, bytes: all };
  } catch (e) { return { ok: false, threw: true, error: String((e && e.message) || e) }; }
  finally { clearTimeout(to); }
}

function skip(r, why) { r.state = 'skipped'; r.skippedReason = why; }
function fail(r, category, reason) {
  r.state = 'failed';
  const oe = (r.net.find((n) => n.error) || {}).error || (r.deepReq && r.deepReq.error) || null;
  r.observedError = oe;
  let hint = '';
  if (oe && /BLOCKED_BY_CLIENT/.test(oe)) hint = ' The page\'s own request was blocked by a content blocker (net::ERR_BLOCKED_BY_CLIENT); blocked "bait" scripts are common in anti-adblock designs.';
  r.failure = { category, reason: reason + hint, observedNetworkError: oe };
}
function noteAttempt(r, method, res) {
  r.attempts.push({ method, ok: !!(res && res.ok), httpStatus: res && res.status != null ? res.status : null, error: res && (res.error || res.reason) || null });
}
async function accept(r, res, method) {
  const ct = (res.headers && res.headers['content-type']) || '';
  if (!r.definite && !r.jsLikely && !(JS_CT.test(ct) || JS_EXT.test(r.url))) { skip(r, 'Response content-type "' + ct + '" is not JavaScript; not saved.'); return; }
  const bytes = res.bytes;
  if (totalBytes + bytes.length > MAX_TOTAL) { fail(r, 'size-budget', 'Total download budget (' + MAX_TOTAL + ' bytes) exhausted.'); return; }
  totalBytes += bytes.length;
  const head = bytesToText(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (/^<(!doctype html|html|head|body)/.test(head)) r.warnings.push('Body looks like HTML, not JavaScript (could be an error, login or consent page).');
  r.bytes = bytes; r.size = bytes.length; r.sha256 = await sha256Hex(bytes);
  r.httpStatus = res.status ?? null; r.contentType = ct || null; r.respHeaders = res.headers || null;
  r.finalUrl = res.finalUrl && stripHash(res.finalUrl) !== r.url ? res.finalUrl : null; r.redirected = !!res.redirected;
  r.method = method; r.state = 'downloaded';
}

async function retrieve(r, ctx) {
  if (r.nonGet) return skip(r, 'Original request method was not GET (' + ((r.net[0] && r.net[0].method) || 'unknown') + '); not replayed to avoid side effects.');
  if (!r.definite && !r.jsLikely) return skip(r, 'Not fetched: discovered as fetch/XHR/other without an observed JavaScript content-type. Not replayed (avoids side effects and unrelated downloads). Reload & Capture or Deep capture can record exact bodies.');
  if (r.url.startsWith('data:')) {
    const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(r.url);
    try {
      const bytes = m[2] ? b64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
      return await accept(r, { ok: true, status: 200, headers: { 'content-type': m[1] || 'text/plain' }, bytes }, 'data-url');
    } catch (e) { return fail(r, 'decode-error', 'Could not decode data: URL: ' + e); }
  }
  const key = stripHash(r.url);
  const db = ctx.deep && ctx.deep.bodies.get(key);
  if (db) { noteAttempt(r, 'debugger-network-body', { ok: true, status: db.status }); return await accept(r, { ok: true, status: db.status, headers: db.headers && db.headers['content-type'] ? { 'content-type': db.headers['content-type'] } : { 'content-type': db.mime || '' }, bytes: db.bytes }, 'debugger-network-body'); }
  if (r.hookBlobText != null) { noteAttempt(r, 'hook-blob-read', { ok: true }); return await accept(r, { ok: true, status: 200, headers: { 'content-type': (r.blobInfo && r.blobInfo.type) || '' }, bytes: new TextEncoder().encode(r.hookBlobText) }, 'hook-blob-read'); }

  let res = null;
  const pf = ctx.originFrame.get(originOf(r.url));
  if (pf != null) {
    res = await execFetch(pf, r.url); noteAttempt(r, 'page-context-fetch', res);
    if (res.threw) res = null; // network error: try the extension fetch next
  }
  if (!res && !r.url.startsWith('blob:')) { res = await extFetch(r.url); noteAttempt(r, 'extension-fetch', res); if (res.threw) res = { ...res, fatal: true }; }
  if (res && res.ok && res.bytes) return await accept(r, res, r.attempts[r.attempts.length - 1].method);

  const ds = (r.deepScripts || []).find((s) => s.source != null);
  if (ds) { noteAttempt(r, 'debugger-script-source', { ok: true }); r.warnings.push('Content is the debugger\'s post-parse script source, not the raw HTTP body.'); return await accept(r, { ok: true, status: null, headers: { 'content-type': 'application/javascript' }, bytes: new TextEncoder().encode(ds.source) }, 'debugger-script-source'); }

  if (!res) return fail(r, 'not-retrievable', r.url.startsWith('blob:') ? 'blob: URL has no matching live origin/frame (revoked or from a closed context).' : 'No retrieval method available.');
  if (res.reason) return fail(r, 'too-large', 'Resource rejected: ' + res.reason);
  if (res.status && !res.ok) return fail(r, 'http-error', 'HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : '') + ' when re-requesting.');
  return fail(r, 'network-error', 'Request failed (' + (res.error || 'unknown error') + '). Typical causes: CORS/network error, blocked by a content blocker, expired or single-use URL, or the server rejected a cookie-less request.');
}

// ------------------------------------------------------------------ main
async function run() {
  const t0 = Date.now(), errors = [];
  let tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('This page type cannot be collected: ' + (tab.url || 'unknown'));
  const topHost = new URL(tab.url).hostname;
  job.domain = topHost;
  let deepCap = null, hookOn = false, reloadInfo = null;

  try {
    if (deep) { await phase('Attaching debugger (deep capture)', 4); deepCap = new DeepCapture(tabId); await deepCap.start(); }
    if (mode === 'reload') {
      await phase('Installing capture hook and reloading page', 8);
      hookOn = await registerHook(tab.url).catch((e) => { errors.push('Hook registration failed: ' + e.message); return false; });
      reloadInfo = await reloadAndWait();
      await phase('Reload ' + reloadInfo + '; letting late scripts run', 20);
      await sleep(SETTLE_MS);
    } else if (deep) await sleep(1500);
    tab = await chrome.tabs.get(tabId);
    await phase('Collecting DOM and script inventory from all frames', 28);
    frames = await collectFrames();
    if (hookOn) hookDumps = await dumpHooks().catch((e) => { errors.push('Hook dump failed: ' + e.message); return []; });
    netLog = await chrome.runtime.sendMessage({ type: 'getLog', tabId }).catch(() => null);
    if (deepCap) {
      await phase('Reading debugger script sources', 34);
      const docUrls = new Set([...frames.map((f) => stripHash(f.frameUrl)), stripHash(tab.url)]);
      deepData = await deepCap.finish((s) => !s.url || (/^(https?:|blob:)/.test(s.url) && !docUrls.has(stripHash(s.url)) && !deepCap.bodies.has(stripHash(s.url))));
    }
  } finally {
    if (deepCap) await deepCap.stop();
    if (hookOn) { try { await chrome.scripting.unregisterContentScripts({ ids: ['aafc-hook'] }); } catch {} }
  }
  if (!frames.length) throw new Error('Could not inject the collector into the page (restricted page or navigation in progress).');

  // ---------- build resource table
  await phase('Building resource inventory', 40);
  const NONJS = /\.(css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|json|map)(\?|#|$)/i;
  const topFrame = frames.find((f) => f.isTop) || frames[0];
  const docUrls = new Set([...frames.map((f) => stripHash(f.frameUrl)), stripHash(tab.url)]);
  const originFrame = new Map();
  for (const f of frames) { const o = originOf(f.frameUrl); if (o && o !== 'null' && (!originFrame.has(o) || f.frameId === 0)) originFrame.set(o, f.frameId); }
  const pageOrigins = new Set(originFrame.keys());

  for (const fr of frames) {
    for (const s of fr.scripts) if (s.src) addRes(s.src, { via: 'script-element', frameId: fr.frameId, definite: true, attrs: { type: s.type, async: s.async, defer: s.defer, noModule: s.noModule, crossOrigin: s.crossOrigin, integrity: s.integrity, referrerPolicy: s.referrerPolicy, id: s.id, domPath: s.path, inHead: s.inHead, frameId: fr.frameId } });
    for (const e of fr.perf) {
      let path = ''; try { path = new URL(e.name).pathname; } catch {}
      if (NONJS.test(path) || e.initiatorType === 'iframe') continue;
      if (e.initiatorType === 'script' || JS_EXT.test(path)) addRes(e.name, { via: 'resource-timing:' + e.initiatorType, frameId: fr.frameId, definite: true, perf: e });
      else addRes(e.name, { via: 'resource-timing:' + e.initiatorType, frameId: fr.frameId, perf: e });
    }
    for (const sw of fr.serviceWorkers || []) for (const k of ['installing', 'waiting', 'active']) if (sw[k]) addRes(sw[k].scriptURL, { via: 'serviceWorker.getRegistrations(' + k + ')', definite: true, kind: 'service-worker', force: true, frameId: fr.frameId });
    if (fr.swController) addRes(fr.swController, { via: 'navigator.serviceWorker.controller', definite: true, kind: 'service-worker', force: true });
  }

  const netRecs = (netLog && netLog.recs) || [];
  const tabless = ((netLog && netLog.tabless) || []).filter((r) => r.initiator && pageOrigins.has(r.initiator));
  for (const rec of [...netRecs, ...tabless]) {
    if (rec.type === 'main_frame' || rec.type === 'sub_frame') continue;
    const r = addRes(rec.url, { via: 'webRequest:' + rec.type + (rec.tabless ? ' (request without tab, e.g. worker)' : ''), frameId: rec.tabless ? null : rec.frameId });
    if (!r) continue;
    r.net.push(rec);
    let path = ''; try { path = new URL(rec.url).pathname; } catch {}
    if (rec.type === 'script') r.definite = true;
    else if ((rec.contentType && JS_CT.test(rec.contentType)) || JS_EXT.test(path)) r.jsLikely = true;
    if (rec.method && rec.method !== 'GET') r.nonGet = true;
  }

  for (const h of hookDumps) {
    const rs = (u) => { try { return new URL(u, h.url).href; } catch { return u; } };
    for (const w of h.workers) addRes(rs(w.url), { via: 'hook:new Worker', definite: true, kind: 'worker', force: true, frameId: h.frameId });
    for (const w of h.sharedWorkers) addRes(rs(w.url), { via: 'hook:new SharedWorker', definite: true, kind: 'shared-worker', force: true, frameId: h.frameId });
    for (const w of h.swRegister) addRes(rs(w.url), { via: 'hook:serviceWorker.register', definite: true, kind: 'service-worker', force: true });
    for (const d of h.dynScripts) if (d.src) addRes(rs(d.src), { via: 'hook:mutation-observer (script src)', definite: true, frameId: h.frameId });
    for (const b of h.blobs) {
      const isJs = /javascript|ecmascript/i.test(b.type);
      const r = R.get(stripHash(b.url)) || (isJs ? addRes(b.url, { via: 'hook:URL.createObjectURL', frameId: h.frameId, jsLikely: true }) : null);
      if (r) { r.blobInfo = { type: b.type, size: b.size, createdAtMs: b.t, stack: b.stack }; if (b.text != null) r.hookBlobText = b.text; }
    }
  }

  const runtimeScripts = []; let debuggerInlineCount = 0;
  if (deepData) {
    for (const q of deepData.reqs) {
      if (q.type === 'Script' || JS_CT.test(q.mime || '') || JS_EXT.test(q.url)) {
        const r = addRes(q.url, { via: 'debugger:Network (' + q.type + ')', definite: q.type === 'Script', jsLikely: true });
        if (r) { r.deepReq = q; r.initiators.push({ type: q.initiator.type, url: q.initiator.url ? san(q.initiator.url) : null, line: q.initiator.line, stack: (q.initiator.stack || []).map((f) => ({ ...f, url: san(f.url) })) }); }
      }
    }
    for (const s of deepData.scripts) {
      if (!s.url) runtimeScripts.push(s);
      else if (docUrls.has(stripHash(s.url))) debuggerInlineCount++;
      else if (/^(https?:|blob:)/.test(s.url)) { const r = addRes(s.url, { via: 'debugger:Debugger.scriptParsed', definite: true, jsLikely: true }); if (r) (r.deepScripts = r.deepScripts || []).push(s); }
    }
  }

  for (const r of R.values()) { r.party = isThirdParty(r.url, topHost) ? 'third-party' : 'first-party'; r.sameOriginAsPage = originOf(r.url) === originOf(tab.url); }
  const inlineCount = frames.reduce((n, f) => n + f.scripts.filter((s) => s.text != null).length, 0);
  await setJob({ discovered: R.size, inline: inlineCount });

  // ---------- download
  const cands = [...R.values()];
  await phase('Retrieving ' + cands.length + ' resources (concurrency ' + CONC + ')', 45);
  const ctx = { deep: deepData, originFrame }; let done = 0;
  await pool(cands, CONC, async (r) => {
    try { await retrieve(r, ctx); } catch (e) { fail(r, 'internal-error', String((e && e.stack) || e)); }
    done++;
    if (done % 4 === 0 || done === cands.length) {
      const c = (s) => cands.filter((x) => x.state === s).length;
      await setJob({ pct: 45 + Math.round((done / cands.length) * 40), downloaded: c('downloaded'), failed: c('failed'), skipped: c('skipped'), phase: 'Retrieving resources (' + done + '/' + cands.length + ')' });
    }
  });
  const dl = cands.filter((r) => r.state === 'downloaded'), failed = cands.filter((r) => r.state === 'failed'), skipped = cands.filter((r) => r.state === 'skipped');
  await setJob({ downloaded: dl.length, failed: failed.length, skipped: skipped.length });
  const byHash = new Map();
  for (const r of dl) { if (!byHash.has(r.sha256)) byHash.set(r.sha256, []); byHash.get(r.sha256).push(r); }
  for (const g of byHash.values()) if (g.length > 1) for (const r of g) r.sameContentAs = g.filter((x) => x !== r).map((x) => x.id);

  // ---------- assemble archive
  await phase('Building ZIP', 88);
  const used = new Set();
  const uniq = (p) => { let q = p, i = 1; while (used.has(q)) q = p.replace(/(\.[A-Za-z0-9]+)?$/, '_' + (++i) + '$1'); used.add(q); return q; };
  for (const r of dl) {
    const base = fileBase(r.url), m = /^(.*?)(\.(?:m|c)?js)?$/i.exec(base);
    const dir = r.kind === 'service-worker' ? 'service-workers' : (r.kind === 'worker' || r.kind === 'shared-worker') ? 'workers' : r.url.startsWith('blob:') ? 'blobs' : r.party;
    r.file = uniq('javascript/' + dir + '/' + pad(r.id, 4) + '_' + safeName(hostOf(r.url) || 'local', 40) + '_' + safeName(m[1], 60) + '_' + r.sha256.slice(0, 8) + (m[2] || '.js'));
  }
  const scriptFile = new Map(); const domHashes = new Set(); const inlineEntries = [];
  for (const fr of frames) for (const s of fr.scripts) {
    const e = { frameId: fr.frameId, frameUrl: san(fr.frameUrl), index: s.index, kind: s.kind, type: s.type, id: s.id, src: s.src ? san(s.src) : null, attrs: s.attrs, async: s.async, defer: s.defer, noModule: s.noModule, crossOrigin: s.crossOrigin, integrity: s.integrity, hasNonce: s.hasNonce, domPath: s.path, inHead: s.inHead, textLength: s.textLength ?? null, truncated: !!s.truncated, file: null, sha256: null };
    if (s.src) { const r = R.get(stripHash(s.src)); if (r) { e.resourceId = r.id; e.file = r.file || null; e.sha256 = r.sha256 || null; e.resourceState = r.state; } }
    else if (s.text != null) {
      const exec = s.kind === 'inline-js' || s.kind === 'inline-module';
      const dir = exec ? 'inline' : (s.kind === 'other-data' ? 'inline/other-data' : 'inline/json');
      const ext = exec ? (s.kind === 'inline-module' ? '.mjs' : '.js') : (s.kind === 'other-data' ? '.txt' : '.json');
      e.file = uniq('javascript/' + dir + '/frame' + fr.frameId + '_' + pad(s.index, 3) + (s.id ? '_' + safeName(s.id, 30) : '') + ext);
      e.sha256 = await sha256Hex(new TextEncoder().encode(s.text)); e.text = s.text; domHashes.add(e.sha256);
    }
    scriptFile.set(fr.frameId + ':' + s.index, e.file); inlineEntries.push(e);
  }
  const dynamicExtra = [];
  for (const h of hookDumps) for (const d of h.dynScripts) {
    if (d.src || !d.text) continue;
    const sha = await sha256Hex(new TextEncoder().encode(d.text));
    if (domHashes.has(sha)) continue; domHashes.add(sha);
    const file = uniq('javascript/inline/dynamic-observed/frame' + h.frameId + '_' + pad(dynamicExtra.length + 1, 3) + (d.id ? '_' + safeName(d.id, 30) : '') + '.js');
    dynamicExtra.push({ frameId: h.frameId, file, sha256: sha, textLength: d.textLength, type: d.type, id: d.id, parent: d.parent, observedAtMs: d.t, createdStack: d.createdStack, text: d.text, note: 'Inline script observed entering the DOM during capture but not present in the final DOM snapshot (e.g. removed itself) or only present in observed form.' });
  }
  runtimeScripts.forEach((s, i) => { if (s.source != null) s.file = uniq('javascript/runtime-generated/' + pad(i + 1, 4) + '_' + safeName(s.target, 14) + '_' + safeName(s.sid, 10) + '_' + safeName(s.scriptId, 10) + '.js'); });

  const exportNet = (n) => ({ url: san(n.url), method: n.method, type: n.type, frameId: n.tabless ? null : n.frameId, initiatorOrigin: n.initiator, requestWithoutTab: n.tabless, httpStatus: n.status ?? null, contentType: n.contentType || null, contentLength: n.contentLength ?? null, contentEncoding: n.contentEncoding || null, fromCache: n.fromCache ?? null, serverIp: n.ip || null, redirectedTo: n.redirectedTo ? san(n.redirectedTo) : null, finalUrl: n.finalUrl ? san(n.finalUrl) : null, error: n.error || null, startedAtEpochMs: n.t, endedAtEpochMs: n.tEnd ?? null, durationMs: n.tEnd ? n.tEnd - n.t : null, party: isThirdParty(n.url, topHost) ? 'third-party' : 'first-party' });
  const exportRes = (r) => ({
    id: r.id, url: san(r.url), urlWasRedacted: sanitizeUrl(r.url).redacted, kind: r.kind, party: r.party, sameOriginAsPage: r.sameOriginAsPage,
    treatedAsDefinitelyScript: r.definite, javascriptContentTypeObserved: r.jsLikely, discoveredVia: [...r.via], frameIds: [...r.frames],
    state: r.state, file: r.file || null, sha256: r.sha256 || null, sameContentAsResourceIds: r.sameContentAs || [], sizeBytes: r.size ?? null,
    httpStatus: r.httpStatus ?? null, contentType: r.contentType || null, finalUrl: r.finalUrl ? san(r.finalUrl) : null, redirected: !!r.redirected,
    responseHeaders: r.respHeaders || null, retrievalMethod: r.method || null, attempts: r.attempts, failure: r.failure || null, skippedReason: r.skippedReason || null,
    warnings: r.warnings, scriptElement: r.attrs || null, resourceTiming: r.perf ? { ...r.perf, name: san(r.perf.name) } : null,
    observedRequests: r.net.map(exportNet), observedNetworkError: r.observedError || ((r.net.find((n) => n.error) || {}).error) || null,
    initiators: r.initiators, blob: r.blobInfo || null
  });
  const resources = [...R.values()].map(exportRes);

  // DOM evidence
  let adHtml = '<!-- Candidate DOM elements for anti-adblock analysis. Each section lists WHY it was selected.\n     Selection is by dialog semantics, large high-z-index overlays and adblock-related wording. It is NOT proof that an element performs detection. -->\n';
  const domFrames = frames.map((fr) => {
    for (const ev of fr.evidence) if (ev.outerHTML) adHtml += '\n<!-- ===== frame ' + fr.frameId + ' | ' + san(fr.frameUrl).replace(/--/g, '- -') + ' | ' + ev.path.replace(/--/g, '- -') + ' | visible=' + ev.visible + ' | ' + ev.reasons.join('; ').replace(/--/g, '- -') + ' ===== -->\n' + ev.outerHTML + '\n';
    for (const sh of fr.shadowRoots) adHtml += '\n<!-- ===== frame ' + fr.frameId + ' | open shadow root host ' + sh.hostPath.replace(/--/g, '- -') + ' ===== -->\n' + sh.html + '\n';
    return {
      frameId: fr.frameId, url: san(fr.frameUrl), isTop: fr.isTop, title: fr.title, readyState: fr.readyState, viewport: fr.viewport, counts: fr.counts,
      bodyState: fr.bodyState, elementsAtViewportCentreTopToBottom: fr.topElements, overlayCandidates: fr.overlays, adblockWordingMatches: fr.textMatches,
      evidence: fr.evidence.map(({ outerHTML, scriptsAssociated, ...e }) => ({ ...e, outerHTMLIn: 'dom/anti-adblock-elements.html', scriptsAssociated: (scriptsAssociated || []).map((a) => ({ ...a, frameId: fr.frameId, file: scriptFile.get(fr.frameId + ':' + a.scriptIndex) || null })) })),
      iframes: fr.iframes.map((f) => ({ ...f, src: f.src ? san(f.src) : null })), openShadowRoots: fr.shadowRoots.map((s) => ({ hostPath: s.hostPath, htmlLength: s.html.length })),
      inlineEventHandlers: fr.handlers, javascriptUrlAttributeCount: fr.javascriptUrls, htmlTruncated: fr.htmlTruncated, notes: fr.notes
    };
  });

  const ts = new Date(), day = ts.toISOString().slice(0, 10);
  const zipName = 'anti-adblock-analysis-' + safeName(topHost, 60) + '-' + day + '.zip';
  const cnt = (f) => cands.filter(f).length;
  const kinds = { executable: 0, module: 0, json: 0, importmap: 0, otherData: 0 };
  for (const e of inlineEntries) { if (e.text == null) continue; if (e.kind === 'inline-js') kinds.executable++; else if (e.kind === 'inline-module') kinds.module++; else if (e.kind === 'json') kinds.json++; else if (e.kind === 'importmap') kinds.importmap++; else kinds.otherData++; }
  let isBrave = null; try { isBrave = navigator.brave ? await navigator.brave.isBrave() : false; } catch {}

  const limitations = [
    'Response bodies are re-requested by the extension (GET only, no cookies for cross-origin URLs) unless Deep capture + Reload recorded the original bytes. A re-request can differ from what the page originally received (personalised, rotating or expiring scripts, A/B variants).',
    'Request status/initiator/error data exists only for requests the background monitor saw. Requests made before the extension was installed/enabled, before the service worker started observing this tab, or that were evicted from the 3000-entry per-tab log are not recoverable; Resource Timing (first ~250 entries by default) only partially compensates.',
    'webRequest reports the initiating ORIGIN, not the initiating script. Which script loaded which script is only available in Deep capture (debugger initiator stacks).',
    'Inline scripts that removed themselves from the DOM, eval()/new Function() code, and dynamic import() graphs are only observable with Reload & Capture (inline scripts) or Deep capture (all runtime-parsed code).',
    'Dedicated/shared worker scripts are only identified via Reload & Capture hook, Deep capture, or webRequest records; code inside workers (including importScripts) is only captured with Deep capture.',
    'Blob: URLs are only readable while still alive in a frame whose origin matches; revoked blobs cannot be recovered.',
    'Frames that cannot be injected (sandboxed, about:blank/srcdoc, error pages, closed shadow roots) are not inspected. Open shadow roots are captured as HTML only.',
    'Deep capture covers the main frame, same-process iframes and workers attached via auto-attach; coverage of out-of-process cross-origin iframes depends on the browser version. The debugger infobar and DevTools-like state may change how a page behaves.',
    'The page is observed with the extension present. A site may behave differently when it detects extensions, hooks or a debugger.',
    'First/third-party classification uses a heuristic registrable-domain rule (no public-suffix list).',
    'Sensitive-looking URL query values, fragments and credentials are redacted in exported metadata; input values, textareas, CSRF/token meta tags and nonces are redacted in HTML snapshots. Inline scripts and downloaded files are stored as-is and may still contain page-specific identifiers.'
  ];
  if (mode === 'current') limitations.push('Collect Current Page did not reload the page: only what the page, the HTTP cache of the monitor log and the browser still held at collection time is included.');
  if (netLog && !netLog.pageUrl && mode === 'current') limitations.push('The background monitor has no record of this page\'s navigation (page opened before the extension was active, or log lost); network metadata for this page is incomplete.');
  if (frames.length === 1 && frames[0].iframes.length) limitations.push('Declared iframes exist but only the top frame was inspected (injection into child frames did not return data).');
  if (deepData) limitations.push(...deepData.notes.slice(0, 20).map((n) => 'Deep capture note: ' + n));
  if (hookDumps.length === 0 && mode === 'reload') limitations.push('Reload hook returned no data (page may have blocked it, or navigated to another domain).');

  const report = {
    tool: { name: 'Anti-Adblock JS Forensic Collector', version: VERSION, mode: mode === 'reload' ? 'reload-and-capture' : 'collect-current-page', deepCapture: deep, captureHook: hookOn },
    domain: topHost, pageUrl: san(tab.url), pageUrlWasRedacted: sanitizeUrl(tab.url).redacted, title: topFrame.title, collectedAt: ts.toISOString(), durationMs: Date.now() - t0,
    browser: { userAgent: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands : null, isBrave, platform: navigator.platform, language: navigator.language },
    counts: {
      discoveredResources: cands.length, downloaded: dl.length, failed: failed.length, skippedNotJavaScriptOrNotReplayed: skipped.length,
      firstPartyResources: cnt((r) => r.party === 'first-party'), thirdPartyResources: cnt((r) => r.party === 'third-party'),
      externalScriptElements: frames.reduce((n, f) => n + f.scripts.filter((s) => s.src).length, 0), inlineScripts: kinds, dynamicInlineScriptsObservedOnly: dynamicExtra.length,
      runtimeGeneratedScriptsCaptured: runtimeScripts.filter((s) => s.source != null).length, runtimeGeneratedScriptsSeen: runtimeScripts.length, framesInspected: frames.length,
      serviceWorkerScripts: cnt((r) => r.kind === 'service-worker'), dedicatedWorkerScripts: cnt((r) => r.kind === 'worker'), sharedWorkerScripts: cnt((r) => r.kind === 'shared-worker'), webRequestRecordsForTab: netRecs.length
    },
    workers: {
      dedicated: hookDumps.flatMap((h) => h.workers.map((w) => ({ frameId: h.frameId, url: san(w.url), options: w.options, createdAtMs: w.t, creationStack: w.stack }))),
      shared: hookDumps.flatMap((h) => h.sharedWorkers.map((w) => ({ frameId: h.frameId, url: san(w.url), options: w.options, createdAtMs: w.t, creationStack: w.stack }))),
      serviceWorkerRegistrations: frames.flatMap((f) => f.serviceWorkers.map((s) => ({ frameId: f.frameId, scope: s.scope, installing: s.installing && { ...s.installing, scriptURL: san(s.installing.scriptURL) }, waiting: s.waiting && { ...s.waiting, scriptURL: san(s.waiting.scriptURL) }, active: s.active && { ...s.active, scriptURL: san(s.active.scriptURL) } }))),
      serviceWorkerRegisterCalls: hookDumps.flatMap((h) => h.swRegister.map((w) => ({ frameId: h.frameId, url: san(w.url), options: w.options, creationStack: w.stack }))),
      debuggerTargets: deepData ? deepData.targets.map((t) => ({ type: t.type, url: san(t.url || '') })) : null,
      note: 'Empty lists can mean "none exist" OR "not observable in this mode"; see limitations.'
    },
    iframes: frames.map((f) => ({ frameId: f.frameId, url: san(f.frameUrl), isTop: f.isTop, declaredIframes: f.iframes.length })),
    domEvidence: domFrames.map((f) => ({ frameId: f.frameId, url: f.url, overlayCandidates: f.overlayCandidates, adblockWordingMatches: f.adblockWordingMatches, evidenceElements: f.evidence.length, bodyState: f.bodyState, elementsAtViewportCentreTopToBottom: f.elementsAtViewportCentreTopToBottom })),
    network: { monitorSawNavigation: !!(netLog && netLog.pageUrl), requestsRecorded: netRecs.length, requestsWithErrors: netRecs.filter((n) => n.error).map((n) => ({ url: san(n.url), type: n.type, error: n.error })), debuggerRequestsRecorded: deepData ? deepData.reqs.length : null },
    failedResourceIds: failed.map((r) => r.id), limitations, errors,
    howToUse: 'Start with report.json, then metadata/resources.json and dom/dom-report.json. Files under javascript/ are exact bytes (see sha256). Entries in network/failed-resources.json were discovered but NOT retrieved; do not assume their content. The anti-adblock mechanism may live in any file: analyse semantically, do not rely on filenames.'
  };
  const summary = { zipName, mode: report.tool.mode, deepCapture: deep, startedAt: new Date(t0).toISOString(), finishedAt: ts.toISOString(), durationMs: Date.now() - t0, counts: report.counts, totalDownloadedBytes: totalBytes, permissionsUsed: { host: 'http(s) pages (inject collector, fetch scripts, observe requests)', scripting: true, webRequest: 'observe only', storage: 'session (progress and request log only)', debugger: deep }, errors };

  const readme = `ANTI-ADBLOCK JAVASCRIPT FORENSIC ARCHIVE
=========================================
Site: ${topHost}
Page: ${san(tab.url)}
Collected: ${ts.toISOString()}
Mode: ${report.tool.mode}${deep ? ' + Deep capture (debugger)' : ''}
Generated locally by Anti-Adblock JS Forensic Collector ${VERSION}. Nothing was uploaded anywhere.
The collector only observes. It does not bypass, block or modify any detection.

COUNTS
  Discovered resources: ${cands.length} (first-party ${report.counts.firstPartyResources}, third-party ${report.counts.thirdPartyResources})
  Downloaded: ${dl.length}    Failed: ${failed.length}    Skipped: ${skipped.length}
  Inline scripts: ${kinds.executable + kinds.module} executable, ${kinds.json + kinds.importmap} JSON/importmap, ${kinds.otherData} other data blocks

LAYOUT
  report.json                       Start here: summary, counts, limitations
  javascript/first-party/           Downloaded external scripts from the page's own site (heuristic)
  javascript/third-party/           Downloaded external scripts from other domains
  javascript/inline/                Inline <script> contents (inline/json = JSON/importmap blocks)
  javascript/workers/               Worker / SharedWorker scripts (when identified)
  javascript/service-workers/       Service worker scripts
  javascript/blobs/                 blob: scripts read from the page
  javascript/runtime-generated/     eval/new Function/anonymous code (Deep capture only)
  dom/page.html                     Sanitized snapshot of the live DOM (top frame)
  dom/anti-adblock-elements.html    Candidate dialog/overlay/wording elements with the reason each was selected
  dom/dom-report.json               Structure, computed styles, ancestors, what is on top at viewport centre, body lock state
  dom/frames/                       Snapshots of child frames
  network/requests.json             Observed requests, Resource Timing, debugger network data (if any)
  network/failed-resources.json     Resources found but NOT retrieved, with reasons (failed and skipped)
  metadata/scripts.json             Every <script> element (+ runtime/dynamic scripts) mapped to files
  metadata/resources.json           Every discovered resource: provenance, hashes, status, retrieval attempts
  metadata/collection-summary.json  Run summary

READING THE METADATA
  state "downloaded" = bytes are in the archive at "file" (sha256 given).
  state "failed"     = content NOT available; "failure" explains why. Do not assume what the file contained.
  state "skipped"    = deliberately not fetched/saved (non-JS, or fetch/XHR not replayed); see "skippedReason".
  Redacted URL parts appear as [REDACTED]; fragments are removed.

IMPORTANT LIMITATIONS
${limitations.map((l) => '  - ' + l).join('\n')}

SUGGESTED PROMPT FOR AN AI ASSISTANT
  "This archive was collected from a page showing an anti-adblock message. Read report.json first. Identify which
   script(s) detect the adblocker and how (bait elements, blocked-request probes, timing checks, API tampering...),
   how the blocking dialog is created and shown, and which DOM nodes it uses (dom/). Then propose a uBlock Origin
   scriptlet (preferred) or Tampermonkey userscript. Do not assume files that appear only in failed-resources.json."
`;

  const zip = new ZipWriter(); const root = 'anti-adblock-analysis/';
  const add = (p, d, o) => zip.add(root + p, d, o);
  const j = (o) => JSON.stringify(o, null, 2);
  await add('README.txt', readme);
  await add('report.json', j(report));
  for (const r of dl) { await add(r.file, r.bytes); r.bytes = null; }
  for (const e of inlineEntries) if (e.file && e.text != null) await add(e.file, e.text);
  for (const d of dynamicExtra) await add(d.file, d.text);
  for (const s of runtimeScripts) if (s.file) await add(s.file, s.source);
  await add('dom/page.html', topFrame.html || '<!-- HTML snapshot unavailable -->');
  const frameFiles = [];
  for (const fr of frames.filter((f) => f !== topFrame && f.html).slice(0, 40)) { const p = uniq('dom/frames/frame-' + fr.frameId + '_' + safeName(hostOf(fr.frameUrl) || 'frame', 40) + '.html'); frameFiles.push({ frameId: fr.frameId, file: p }); await add(p, fr.html); }
  await add('dom/anti-adblock-elements.html', adHtml);
  await add('dom/dom-report.json', j({ note: 'Evidence elements are CANDIDATES selected by structure/wording. Do not assume each is responsible for detection.', frameSnapshots: [{ frameId: topFrame.frameId, file: 'dom/page.html' }, ...frameFiles], frames: domFrames }));
  await add('network/requests.json', j({
    note: 'Request headers, cookies and bodies are never recorded. "initiatorOrigin" is an origin, not a script.',
    monitor: { sawNavigationOfThisPage: !!(netLog && netLog.pageUrl), monitorStartedAtEpochMs: netLog ? netLog.startedAt : null },
    webRequest: netRecs.map(exportNet), webRequestWithoutTabMatchedToPageOrigins: tabless.map(exportNet),
    resourceTiming: frames.map((fr) => ({ frameId: fr.frameId, url: san(fr.frameUrl), entries: fr.perf.map((e) => ({ ...e, name: san(e.name) })) })),
    debugger: deepData ? { requests: deepData.reqs.map((q) => ({ ...q, url: san(q.url), documentURL: q.documentURL ? san(q.documentURL) : null, redirects: (q.redirects || []).map(san), initiator: { ...q.initiator, url: q.initiator.url ? san(q.initiator.url) : null, stack: (q.initiator.stack || []).map((f) => ({ ...f, url: san(f.url) })) } })), notes: deepData.notes } : null
  }));
  await add('network/failed-resources.json', j({ note: 'Discovered but NOT retrieved. category "failed" = a retrieval was attempted or required and did not succeed; "skipped" = deliberately not fetched/saved.', failed: resources.filter((r) => r.state === 'failed'), skipped: resources.filter((r) => r.state === 'skipped') }));
  await add('metadata/scripts.json', j({
    scriptElements: inlineEntries.map(({ text, ...e }) => e),
    dynamicInlineScriptsObservedByHook: dynamicExtra.map(({ text, ...e }) => e),
    runtimeGeneratedScripts: runtimeScripts.map(({ source, ...s }) => ({ ...s, savedAs: s.file || null, sourceLength: source ? source.length : null })),
    debuggerInlineScriptsOfDocumentsNotRepeated: debuggerInlineCount
  }));
  await add('metadata/resources.json', j({ resources }));
  await add('metadata/collection-summary.json', j(summary));

  await phase('Finalizing archive', 96);
  const blob = zip.finish();
  await saveZip(blob, { name: zipName, size: blob.size, createdAt: ts.toISOString() });
  await setJob({ state: 'done', phase: 'Done', pct: 100, zipName, zipSize: blob.size, finishedAt: Date.now(), downloaded: dl.length, failed: failed.length, skipped: skipped.length });
  ui('Done: ' + zipName + ' (' + blob.size + ' bytes). Closing this tab.');
}

(async () => {
  try { await run(); setTimeout(closeSelf, 1500); }
  catch (e) { console.error(e); ui('ERROR: ' + ((e && e.message) || e)); await setJob({ state: 'error', phase: 'Failed', error: String((e && e.message) || e) }); setTimeout(closeSelf, 20000); }
})();
async function closeSelf() { try { const t = await chrome.tabs.getCurrent(); if (t) chrome.tabs.remove(t.id); } catch {} }
