'use strict';
// Passive, observe-only request log (no blocking, no request/response modification).
// Request URLs + metadata only. Never records request headers, cookies or bodies.
const TYPES = ['main_frame', 'sub_frame', 'script', 'xmlhttprequest', 'other'];
const MAX_PER_TAB = 3000;
const FILTER = { urls: ['http://*/*', 'https://*/*'], types: TYPES };
const logs = new Map(); // tabId (or -1 for requests without a tab, e.g. workers) -> {pageUrl,startedAt,recs,idx}
const dirty = new Set();
let saveTimer = null;

const hydrate = (v) => {
  const L = { pageUrl: v.pageUrl || null, startedAt: v.startedAt || 0, recs: v.recs || [], idx: new Map() };
  for (const r of L.recs) L.idx.set(r.rid, r);
  return L;
};
const ready = (async () => {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) if (k.startsWith('log:') && v && Array.isArray(v.recs)) logs.set(Number(k.slice(4)), hydrate(v));
  } catch (e) { console.warn('log restore failed', e); }
})();

const logFor = (id) => { let L = logs.get(id); if (!L) { L = hydrate({ recs: [] }); logs.set(id, L); } return L; };
const find = (d) => { const L = logs.get(d.tabId < 0 ? -1 : d.tabId); return L ? L.idx.get(d.requestId) : null; };
function schedule(id) { dirty.add(id); if (!saveTimer) saveTimer = setTimeout(flush, 1000); }
async function flush() {
  saveTimer = null;
  const ids = [...dirty]; dirty.clear();
  for (const id of ids) {
    const L = logs.get(id); if (!L) continue;
    try { await chrome.storage.session.set({ ['log:' + id]: { pageUrl: L.pageUrl, startedAt: L.startedAt, recs: L.recs } }); }
    catch { L.recs.splice(0, Math.floor(L.recs.length / 2)); L.idx = new Map(L.recs.map((r) => [r.rid, r])); }
  }
}

chrome.webRequest.onBeforeRequest.addListener(async (d) => {
  await ready;
  const tabless = d.tabId < 0;
  if (d.type === 'main_frame' && !tabless) logs.set(d.tabId, hydrate({ pageUrl: d.url, startedAt: d.timeStamp, recs: [] }));
  const L = logFor(tabless ? -1 : d.tabId);
  if (L.idx.has(d.requestId)) return;
  const rec = { rid: d.requestId, url: d.url, method: d.method, type: d.type, frameId: d.frameId, parentFrameId: d.parentFrameId, initiator: d.initiator || null, tabless, t: Math.round(d.timeStamp) };
  L.recs.push(rec); L.idx.set(rec.rid, rec);
  if (L.recs.length > (tabless ? 1500 : MAX_PER_TAB)) { const o = L.recs.shift(); L.idx.delete(o.rid); }
  schedule(tabless ? -1 : d.tabId);
}, FILTER);

chrome.webRequest.onBeforeRedirect.addListener(async (d) => {
  await ready; const r = find(d); if (!r) return;
  r.redirectedTo = d.redirectUrl; r.status = d.statusCode; schedule(d.tabId < 0 ? -1 : d.tabId);
}, FILTER);

chrome.webRequest.onHeadersReceived.addListener(async (d) => {
  await ready; const r = find(d); if (!r) return;
  r.status = d.statusCode; if (d.url !== r.url) r.finalUrl = d.url;
  const h = {};
  for (const x of d.responseHeaders || []) { const n = x.name.toLowerCase(); if (['content-type', 'content-length', 'content-encoding', 'cache-control'].includes(n)) h[n] = x.value; }
  r.contentType = h['content-type'] || null; r.contentLength = h['content-length'] ? Number(h['content-length']) : null; r.contentEncoding = h['content-encoding'] || null;
  schedule(d.tabId < 0 ? -1 : d.tabId);
}, FILTER, ['responseHeaders']);

chrome.webRequest.onCompleted.addListener(async (d) => {
  await ready; const r = find(d); if (!r) return;
  r.done = true; r.status = d.statusCode; r.fromCache = d.fromCache; r.ip = d.ip || null; r.tEnd = Math.round(d.timeStamp); schedule(d.tabId < 0 ? -1 : d.tabId);
}, FILTER);

chrome.webRequest.onErrorOccurred.addListener(async (d) => {
  await ready; const r = find(d); if (!r) return;
  r.error = d.error; r.tEnd = Math.round(d.timeStamp); schedule(d.tabId < 0 ? -1 : d.tabId);
}, FILTER);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready; logs.delete(tabId); dirty.delete(tabId);
  try { await chrome.storage.session.remove('log:' + tabId); } catch {}
});

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  (async () => {
    await ready;
    if (m && m.type === 'getLog') {
      const L = logs.get(m.tabId), T = logs.get(-1);
      return { ok: true, pageUrl: L ? L.pageUrl : null, startedAt: L ? L.startedAt : null, recs: L ? L.recs : [], tabless: T ? T.recs : [] };
    }
    if (m && m.type === 'start') {
      const { job } = await chrome.storage.session.get('job');
      if (job && job.state === 'running' && Date.now() - job.startedAt < 15 * 60e3) return { ok: false, error: 'A collection is already running.' };
      await chrome.storage.session.set({ job: { state: 'running', phase: 'Starting', pct: 0, tabId: m.tabId, domain: m.domain, startedAt: Date.now(), discovered: 0, inline: 0, downloaded: 0, failed: 0, skipped: 0 } });
      const q = new URLSearchParams({ tabId: String(m.tabId), mode: m.mode, deep: m.deep ? '1' : '0' });
      await chrome.tabs.create({ url: chrome.runtime.getURL('worker.html?' + q), active: false });
      return { ok: true };
    }
    return { ok: false, error: 'unknown message' };
  })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
