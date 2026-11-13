// MAIN-world observer. Registered ONLY during "Reload & Capture", at document_start, limited to the
// inspected site's domain. It records; it never blocks, rewrites or fakes anything.
(() => {
  const KEY = Symbol.for('__aafc_hook__');
  try { if (window[KEY]) return; } catch { return; }
  const D = { workers: [], sharedWorkers: [], swRegister: [], dynScripts: [], notes: [] };
  const MAXT = 300000;
  const now = () => Math.round(performance.now());
  const stk = () => { try { return (new Error().stack || '').split('\n').slice(2, 10).map((s) => s.trim()); } catch { return []; } };
  try { performance.setResourceTimingBufferSize(20000); } catch {}

  for (const [name, arr] of [['Worker', 'workers'], ['SharedWorker', 'sharedWorkers']]) {
    try {
      const O = window[name]; if (!O) continue;
      window[name] = new Proxy(O, {
        construct(t, a, nt) {
          try { D[arr].push({ url: String((a[0] && a[0].href) || a[0]), options: a[1] ? { type: a[1].type, name: a[1].name, credentials: a[1].credentials } : null, t: now(), stack: stk() }); } catch {}
          return Reflect.construct(t, a, nt);
        }
      });
    } catch (e) { D.notes.push(name + ' hook failed: ' + e); }
  }

  const blobs = new Map();
  try {
    const oc = URL.createObjectURL;
    URL.createObjectURL = function (o) {
      const u = oc.apply(this, arguments);
      try { if (o instanceof Blob && blobs.size < 300) blobs.set(u, { blob: o, t: now(), stack: stk() }); } catch {}
      return u;
    };
  } catch (e) { D.notes.push('createObjectURL hook failed: ' + e); }

  try {
    const P = ServiceWorkerContainer.prototype, orig = P.register;
    P.register = function (u, o) {
      try { D.swRegister.push({ url: String(u), options: o ? { scope: o.scope, type: o.type } : null, t: now(), stack: stk() }); } catch {}
      return orig.apply(this, arguments);
    };
  } catch {}

  // remember who inserted a <script> (creation stack)
  const stacks = new WeakMap();
  const isS = (n) => n && n.nodeType === 1 && n.tagName === 'SCRIPT';
  for (const [proto, names] of [[Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']], [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'insertAdjacentElement']]]) {
    for (const n of names) {
      try {
        const o = proto[n]; if (typeof o !== 'function') continue;
        proto[n] = function () { try { for (const a of arguments) if (isS(a) && !stacks.has(a)) stacks.set(a, stk()); } catch {} return o.apply(this, arguments); };
      } catch {}
    }
  }

  // record every script element that ever enters the DOM (catches self-removing scripts)
  try {
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const list = isS(n) ? [n] : (n.querySelectorAll ? [...n.querySelectorAll('script')] : []);
        for (const s of list) {
          if (D.dynScripts.length >= 500) return;
          const text = s.src ? null : (s.textContent || '');
          D.dynScripts.push({ t: now(), src: s.src || null, type: s.type || null, id: s.id || null, async: s.async, defer: s.defer, parent: m.target && m.target.nodeName, text: text && text.slice(0, MAXT), textLength: text ? text.length : 0, createdStack: stacks.get(s) || null, ref: new WeakRef(s) });
        }
      }
    }).observe(document, { childList: true, subtree: true });
  } catch (e) { D.notes.push('MutationObserver failed: ' + e); }

  Object.defineProperty(window, KEY, {
    enumerable: false,
    value: {
      dump: async () => {
        const out = [];
        for (const [u, v] of blobs) {
          const b = v.blob, rec = { url: u, type: b.type, size: b.size, t: v.t, stack: v.stack };
          if (b.size <= 2000000 && (/javascript|ecmascript/i.test(b.type) || b.type === '' || b.type === 'text/plain')) {
            try { rec.text = await b.text(); } catch (e) { rec.error = String(e); }
          }
          out.push(rec);
        }
        const dyn = D.dynScripts.map((e) => {
          const o = { ...e }; delete o.ref;
          const s = e.ref && e.ref.deref();
          if (s && !o.src && !o.text) { const t = s.textContent || ''; o.text = t.slice(0, MAXT); o.textLength = t.length; }
          return o;
        });
        return { url: location.href, isTop: window === window.top, workers: D.workers, sharedWorkers: D.sharedWorkers, swRegister: D.swRegister, dynScripts: dyn, blobs: out, notes: D.notes, perfEntries: performance.getEntriesByType('resource').length };
      }
    }
  });
})();
