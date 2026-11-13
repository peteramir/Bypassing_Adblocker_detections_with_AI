// Functions serialized into pages by chrome.scripting.executeScript.
// Each MUST be fully self-contained (no references to module scope).

export async function collectInFrame() {
  const out = {
    frameUrl: location.href, isTop: window === window.top, title: document.title, readyState: document.readyState,
    charset: document.characterSet, docContentType: document.contentType, baseURI: document.baseURI,
    viewport: { w: innerWidth, h: innerHeight }, scripts: [], handlers: [], javascriptUrls: 0, perf: [], iframes: [],
    serviceWorkers: [], swController: null, shadowRoots: [], evidence: [], textMatches: [], overlays: [], bodyState: null,
    topElements: [], html: null, htmlTruncated: false, notes: [], counts: {}
  };
  const note = (m) => out.notes.push(m);
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
  const SENS = /(token|secret|passw|pwd|auth|sess|sig|key|jwt|bearer|cred|otp|csrf|xsrf|mail|code|hash|policy|nonce|ticket)/i;
  const redactUrl = (v) => {
    try {
      if (/^\s*(javascript|data|mailto|tel):/i.test(v) || v.startsWith('#')) return v;
      const x = new URL(v, document.baseURI);
      x.username = ''; x.password = ''; x.hash = '';
      if (x.search) {
        x.search = x.search.slice(1).split('&').map((p) => {
          const i = p.indexOf('='); if (i < 0) return p;
          const k = p.slice(0, i), val = p.slice(i + 1); let dk = k; try { dk = decodeURIComponent(k); } catch {}
          return (SENS.test(dk) || (val.length >= 32 && /^[A-Za-z0-9_\-+/=.%~]+$/.test(val))) ? k + '=[REDACTED]' : p;
        }).join('&');
      }
      return x.href;
    } catch { return v; }
  };
  const sanitizeTree = (root) => {
    root.querySelectorAll('input').forEach((i) => { if (i.hasAttribute('value')) i.setAttribute('value', '[REDACTED]'); });
    root.querySelectorAll('textarea').forEach((t) => { t.textContent = '[REDACTED]'; });
    root.querySelectorAll('meta[name]').forEach((m) => { if (/csrf|token|xsrf|nonce/i.test(m.getAttribute('name'))) m.setAttribute('content', '[REDACTED]'); });
    root.querySelectorAll('[href],[src],[action]').forEach((e) => {
      for (const a of ['href', 'src', 'action']) { const v = e.getAttribute(a); if (v && /[?#]/.test(v) && !v.startsWith('#')) e.setAttribute(a, redactUrl(v)); }
    });
    root.querySelectorAll('[nonce]').forEach((e) => e.removeAttribute('nonce'));
  };
  const safeOuter = (el, max) => {
    const wrap = document.createElement('div'); wrap.appendChild(el.cloneNode(true)); sanitizeTree(wrap);
    const h = wrap.innerHTML; return h.length > max ? h.slice(0, max) + '\n<!-- [truncated] -->' : h;
  };
  const cssPath = (el) => {
    const p = []; let n = el;
    while (n && n.nodeType === 1 && p.length < 14) {
      let s = n.localName;
      if (n.id) { s += '#' + CSS.escape(n.id); p.unshift(s); break; }
      const par = n.parentElement;
      if (par) s += ':nth-child(' + (Array.prototype.indexOf.call(par.children, n) + 1) + ')';
      p.unshift(s); n = par;
    }
    return p.join(' > ');
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sty = (el) => {
    const c = getComputedStyle(el);
    return { position: c.position, zIndex: c.zIndex, display: c.display, visibility: c.visibility, opacity: c.opacity, pointerEvents: c.pointerEvents, overflow: c.overflow, backgroundColor: c.backgroundColor, filter: c.filter, backdropFilter: c.backdropFilter || '' };
  };
  const visible = (el) => { const c = getComputedStyle(el); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const brief = (el) => ({ path: cssPath(el), tag: el.localName, id: el.id || null, classes: [...el.classList].slice(0, 12) });

  // ---- scripts ----
  try {
    const els = [...document.scripts];
    els.forEach((s, i) => {
      const t = (s.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
      let kind;
      if (/^(|module|(text|application)\/(x-)?(java|ecma)script|text\/jscript|text\/livescript)$/.test(t)) kind = t === 'module' ? 'inline-module' : 'inline-js';
      else if (t === 'importmap') kind = 'importmap';
      else if (/json/.test(t) || t === 'speculationrules') kind = 'json';
      else kind = 'other-data';
      const raw = s.getAttribute('src');
      const rec = { index: i, kind: raw ? kind.replace('inline-', 'external-') : kind, type: s.getAttribute('type'), id: s.id || null, src: raw ? abs(raw) : null, async: s.async, defer: s.defer, noModule: s.noModule, crossOrigin: s.crossOrigin, integrity: s.integrity || null, referrerPolicy: s.referrerPolicy || null, hasNonce: s.hasAttribute('nonce'), attrs: {}, path: cssPath(s), inHead: !!s.closest('head') };
      for (const a of s.attributes) { if (a.name === 'nonce') continue; rec.attrs[a.name] = a.name === 'src' ? redactUrl(a.value) : a.value.slice(0, 300); }
      if (!raw) {
        let tx = s.textContent || ''; rec.textLength = tx.length;
        if (tx.length > 3000000) { tx = tx.slice(0, 3000000); rec.truncated = true; }
        rec.text = tx;
      }
      out.scripts.push(rec);
    });
  } catch (e) { note('script enumeration failed: ' + e); }

  // ---- resource timing ----
  try {
    const pe = performance.getEntriesByType('resource'); out.counts.perfEntries = pe.length;
    if (pe.length >= 250) note('Resource Timing buffer holds ' + pe.length + ' entries; the browser default cap is 250, so older entries may have been dropped.');
    out.perf = pe.filter((e) => !['img', 'css', 'video', 'audio', 'track', 'beacon', 'image'].includes(e.initiatorType)).slice(0, 3000).map((e) => ({
      name: e.name, initiatorType: e.initiatorType, startTime: Math.round(e.startTime), duration: Math.round(e.duration), transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, nextHopProtocol: e.nextHopProtocol, responseStatus: e.responseStatus
    }));
  } catch (e) { note('resource timing failed: ' + e); }

  // ---- element sweep: inline handlers, shadow roots, overlay candidates ----
  const vw = innerWidth, vh = innerHeight, ovCand = [];
  try {
    const all = document.getElementsByTagName('*'); out.counts.elements = all.length;
    const lim = Math.min(all.length, 25000);
    if (all.length > lim) note('Element sweep capped at ' + lim + ' of ' + all.length + ' elements.');
    for (let i = 0; i < lim; i++) {
      const el = all[i];
      try {
        for (const a of el.attributes) {
          const n = a.name;
          if (n.length > 2 && n.startsWith('on')) { if (out.handlers.length < 1000) out.handlers.push({ path: cssPath(el), tag: el.localName, attr: n, value: a.value.slice(0, 2000) }); }
          else if ((n === 'href' || n === 'src' || n === 'action' || n === 'formaction') && /^\s*javascript:/i.test(a.value)) out.javascriptUrls++;
        }
        if (el.shadowRoot && out.shadowRoots.length < 50) out.shadowRoots.push({ hostPath: cssPath(el), html: el.shadowRoot.innerHTML.slice(0, 20000) });
        const cs = getComputedStyle(el), pos = cs.position;
        if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') {
          const r = el.getBoundingClientRect();
          const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          const cov = (w * h) / (vw * vh || 1), z = parseInt(cs.zIndex, 10) || 0;
          if (cov >= 0.1 && z >= 10 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0) ovCand.push({ el, cov, z, pos });
        }
      } catch {}
    }
  } catch (e) { note('element sweep failed: ' + e); }
  ovCand.sort((a, b) => b.z - a.z || b.cov - a.cov);
  const overlays = ovCand.slice(0, 15);

  // ---- evidence collection (candidates only; NOT a claim that any of them is the detector) ----
  const ev = new Map();
  const addEv = (el, reason) => { if (!el || el === document.body || el === document.documentElement) return; if (!ev.has(el)) ev.set(el, new Set()); ev.get(el).add(reason); };
  try {
    overlays.forEach((o) => {
      addEv(o.el, 'full-/large-viewport overlay candidate (position=' + o.pos + ', z-index=' + o.z + ', covers ' + Math.round(o.cov * 100) + '% of viewport)');
      out.overlays.push({ ...brief(o.el), position: o.pos, zIndex: o.z, viewportCoveragePct: Math.round(o.cov * 100) });
    });
    const dl = document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog');
    out.counts.dialogElements = dl.length;
    dl.forEach((d) => addEv(d, 'dialog/modal semantics (role=dialog|alertdialog, aria-modal=true or <dialog>)'));
    const AD = /ad[\s_-]?block|ad[\s-]?blocker|ads?[\s-]?(block|filter)|disable (your |the )?(ad|content)|turn off (your )?(ad|content)|ads? (are|is) (being )?(blocked|disabled)|whitelist|allowlist|allow (ads|advertis)|support (us|our)\b.{0,40}\bads?\b|ublock|adguard|brave shields|tracking protection/i;
    const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n, cnt = 0; const seen = new Set();
    while ((n = tw.nextNode()) && cnt < 30000) {
      cnt++;
      const v = n.nodeValue; if (!v || v.length < 8 || v.length > 3000) continue;
      const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || seen.has(p)) continue;
      if (!AD.test(v)) continue;
      seen.add(p);
      const cont = p.closest('[role=dialog],[role=alertdialog],[aria-modal=true],dialog') || (overlays.find((o) => o.el.contains(p)) || {}).el || p;
      if (out.textMatches.length < 40) out.textMatches.push({ text: v.trim().slice(0, 300), parentPath: cssPath(p), containerPath: cssPath(cont) });
      addEv(p, 'own text matches adblock-related wording (wording match only; not proof of detection role)');
      if (cont !== p) addEv(cont, 'container of text matching adblock-related wording');
    }
  } catch (e) { note('evidence collection failed: ' + e); }

  try {
    const els = [...document.scripts]; let budget = 400000;
    const list = [...ev.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 40);
    for (const [el, reasons] of list) {
      const rec = { ...brief(el), role: el.getAttribute('role'), ariaModal: el.getAttribute('aria-modal'), ariaHidden: el.getAttribute('aria-hidden'), visible: visible(el), rect: rect(el), style: sty(el), reasons: [...reasons], innerText: (el.innerText || '').slice(0, 1500), attributes: {} };
      for (const a of el.attributes) if (a.name !== 'nonce') rec.attributes[a.name] = /^(href|src|action)$/.test(a.name) ? redactUrl(a.value) : a.value.slice(0, 300);
      const anc = []; let a = el.parentElement;
      while (a && anc.length < 15) { const c = getComputedStyle(a); anc.push({ tag: a.localName, id: a.id || null, classes: [...a.classList].slice(0, 6), position: c.position, zIndex: c.zIndex, display: c.display, overflow: c.overflow }); a = a.parentElement; }
      rec.ancestors = anc;
      rec.children = [...el.children].slice(0, 25).map((c) => ({ tag: c.localName, id: c.id || null, classes: [...c.classList].slice(0, 6), text: (c.innerText || '').slice(0, 80) }));
      const toks = new Set(); const addT = (t) => { if (t && t.length >= 5 && t.length <= 60) toks.add(t); };
      addT(el.id); el.classList.forEach(addT);
      el.querySelectorAll('[id]').forEach((d, i) => { if (i < 30) addT(d.id); });
      el.querySelectorAll('[class]').forEach((d, i) => { if (i < 30) d.classList.forEach(addT); });
      const hits = [];
      els.forEach((s, idx) => {
        if (el.contains(s)) { hits.push({ scriptIndex: idx, why: 'script element is inside this element' }); return; }
        if (!s.src) { const tx = s.textContent || ''; if (tx) for (const t of toks) if (tx.includes(t)) { hits.push({ scriptIndex: idx, why: 'inline script text contains id/class token "' + t + '" (string match only)' }); break; } }
      });
      rec.scriptsAssociated = hits.slice(0, 20);
      const h = budget > 0 ? safeOuter(el, 30000) : null; if (h) budget -= h.length; rec.outerHTML = h;
      out.evidence.push(rec);
    }
  } catch (e) { note('evidence serialization failed: ' + e); }

  // ---- what is on top at the viewport centre, and page-level lock state ----
  try { out.topElements = (document.elementsFromPoint(vw / 2, vh / 2) || []).slice(0, 8).map((e) => ({ ...brief(e), position: getComputedStyle(e).position, zIndex: getComputedStyle(e).zIndex })); } catch {}
  try {
    out.bodyState = {
      nodes: [document.documentElement, document.body].filter(Boolean).map((e) => { const c = getComputedStyle(e); return { tag: e.localName, classes: [...e.classList], styleAttr: e.getAttribute('style'), overflow: c.overflow, overflowY: c.overflowY, position: c.position, pointerEvents: c.pointerEvents, filter: c.filter, height: c.height }; }),
      inertCount: document.querySelectorAll('[inert]').length,
      ariaHiddenBodyChildren: document.body ? [...document.body.children].filter((c) => c.getAttribute('aria-hidden') === 'true').length : 0
    };
  } catch {}

  // ---- iframes ----
  try {
    out.iframes = [...document.querySelectorAll('iframe,frame')].slice(0, 200).map((f) => {
      let acc = false; try { acc = !!f.contentDocument; } catch {}
      const s = f.getAttribute('src');
      return { path: cssPath(f), src: s ? abs(s) : null, hasSrcdoc: f.hasAttribute('srcdoc'), srcdocLength: (f.getAttribute('srcdoc') || '').length, name: f.name || null, id: f.id || null, title: f.title || null, sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), loading: f.getAttribute('loading'), visible: visible(f), rect: rect(f), sameOriginAccessible: acc };
    });
  } catch (e) { note('iframe enumeration failed: ' + e); }

  // ---- service workers (top frame only) ----
  try {
    if (out.isTop && 'serviceWorker' in navigator && isSecureContext) {
      const regs = await navigator.serviceWorker.getRegistrations();
      const w = (x) => x ? { scriptURL: x.scriptURL, state: x.state } : null;
      out.serviceWorkers = regs.map((r) => ({ scope: r.scope, updateViaCache: r.updateViaCache, installing: w(r.installing), waiting: w(r.waiting), active: w(r.active) }));
      out.swController = navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;
    }
  } catch (e) { note('service worker query failed: ' + e); }

  // ---- sanitized HTML snapshot ----
  try {
    const clone = document.documentElement.cloneNode(true); sanitizeTree(clone);
    let h = '<!DOCTYPE ' + (document.doctype ? document.doctype.name : 'html') + '>\n' + clone.outerHTML;
    const cap = out.isTop ? 4000000 : 400000;
    if (h.length > cap) { h = h.slice(0, cap) + '\n<!-- [truncated by collector] -->'; out.htmlTruncated = true; }
    out.html = h;
  } catch (e) { note('HTML snapshot failed: ' + e); }
  return out;
}

export async function fetchInPage(url, maxBytes) {
  const keep = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'last-modified', 'etag', 'x-content-type-options'];
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'force-cache', redirect: 'follow', signal: ctrl.signal });
    const headers = {}; keep.forEach((k) => { const v = r.headers.get(k); if (v) headers[k] = v; });
    const base = { ok: r.ok, status: r.status, statusText: r.statusText, headers, finalUrl: r.url, redirected: r.redirected };
    const cl = Number(headers['content-length']);
    if (cl > maxBytes) { ctrl.abort(); return { ...base, ok: false, reason: 'too-large (content-length ' + cl + ')' }; }
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.length;
      if (n > maxBytes) { ctrl.abort(); return { ...base, ok: false, reason: 'too-large (> ' + maxBytes + ' bytes)' }; }
      chunks.push(value);
    }
    const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    let bin = ''; for (let i = 0; i < all.length; i += 32768) bin += String.fromCharCode.apply(null, all.subarray(i, i + 32768));
    return { ...base, b64: btoa(bin) };
  } catch (e) {
    return { ok: false, threw: true, error: String((e && e.message) || e) };
  } finally { clearTimeout(to); }
}

export async function dumpHook() {
  try { const h = window[Symbol.for('__aafc_hook__')]; return h ? await h.dump() : null; } catch (e) { return null; }
}
