(async function dumpHook() {
  try { const h = window[Symbol.for('__aafc_hook__')]; return h ? await h.dump() : null; } catch (e) { return null; }
})()