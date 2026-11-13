// Optional "deep" mode: chrome.debugger (Chrome DevTools Protocol). Requires the optional `debugger` permission.
import { b64ToBytes, JS_CT, JS_EXT, stripHash, pool } from './util.js';

export class DeepCapture {
  constructor(tabId) {
    this.tabId = tabId; this.scripts = []; this.reqs = new Map(); this.bodies = new Map(); this.targets = [];
    this.notes = []; this.pending = []; this.bodyBytes = 0; this.attached = false;
  }
  async start() {
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    this.attached = true;
    this._ev = (src, m, p) => { if (src.tabId === this.tabId) { try { this._handle(src, m, p || {}); } catch (e) { this.notes.push('event error ' + m + ': ' + e); } } };
    this._det = (src, reason) => { if (src.tabId === this.tabId) { this.attached = false; this.notes.push('debugger detached: ' + reason); } };
    chrome.debugger.onEvent.addListener(this._ev);
    chrome.debugger.onDetach.addListener(this._det);
    await this._enable({ tabId: this.tabId }, 'page');
  }
  _send(d, m, p) { return chrome.debugger.sendCommand(d, m, p); }
  _dbg(sid) { return sid === 'main' ? { tabId: this.tabId } : { tabId: this.tabId, sessionId: sid }; }
  _label(sid) { if (sid === 'main') return 'page'; const t = this.targets.find((x) => x.sessionId === sid); return t ? t.type : 'unknown'; }
  async _enable(d, label) {
    const f = (what) => (e) => this.notes.push(label + ': ' + what + ' failed: ' + ((e && e.message) || e));
    await this._send(d, 'Network.enable', { maxTotalBufferSize: 200e6, maxResourceBufferSize: 30e6 }).catch(f('Network.enable'));
    await this._send(d, 'Debugger.enable', {}).catch(f('Debugger.enable'));
    await this._send(d, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(f('Target.setAutoAttach'));
  }
  _frames(st) { return st && st.callFrames ? st.callFrames.slice(0, 8).map((f) => ({ fn: f.functionName, url: f.url, line: f.lineNumber, col: f.columnNumber })) : null; }
  _handle(src, m, p) {
    const sid = src.sessionId || 'main';
    switch (m) {
      case 'Target.attachedToTarget': {
        const ti = p.targetInfo || {};
        this.targets.push({ type: ti.type, url: ti.url, targetId: ti.targetId, sessionId: p.sessionId });
        this._enable({ tabId: this.tabId, sessionId: p.sessionId }, ti.type);
        break;
      }
      case 'Debugger.scriptParsed': {
        const aux = p.executionContextAuxData || {}, u = p.url || '';
        if (aux.type === 'isolated' || u.startsWith('chrome-extension://') || u.startsWith('extensions::')) break;
        if (this.scripts.length > 20000) break;
        this.scripts.push({ sid, scriptId: p.scriptId, url: u, startLine: p.startLine, startColumn: p.startColumn, endLine: p.endLine, length: p.length, hash: p.hash, isModule: !!p.isModule, sourceMapURL: p.sourceMapURL || null, hasSourceURL: !!p.hasSourceURL, creationStack: this._frames(p.stackTrace), frameId: aux.frameId || null, target: this._label(sid) });
        break;
      }
      case 'Network.requestWillBeSent': {
        const k = sid + ':' + p.requestId, ini = p.initiator || {};
        const prev = this.reqs.get(k);
        if (prev) { (prev.redirects = prev.redirects || []).push(p.request.url); break; }
        if (this.reqs.size > 8000) break;
        this.reqs.set(k, { sid, requestId: p.requestId, url: p.request.url, method: p.request.method, type: p.type, frameId: p.frameId, documentURL: p.documentURL, initiator: { type: ini.type, url: ini.url || null, line: ini.lineNumber, stack: this._frames(ini.stack) } });
        break;
      }
      case 'Network.responseReceived': {
        const r = this.reqs.get(sid + ':' + p.requestId); if (!r) break;
        const h = p.response.headers || {}, g = (n) => h[n] || h[n.toLowerCase()];
        Object.assign(r, { type: p.type || r.type, status: p.response.status, mime: p.response.mimeType, protocol: p.response.protocol, fromDiskCache: p.response.fromDiskCache, fromServiceWorker: p.response.fromServiceWorker, remoteIp: p.response.remoteIPAddress, headers: { 'content-type': g('content-type'), 'content-length': g('content-length'), 'content-encoding': g('content-encoding') } });
        break;
      }
      case 'Network.loadingFinished': {
        const r = this.reqs.get(sid + ':' + p.requestId); if (!r) break;
        r.finished = true; r.encodedDataLength = p.encodedDataLength;
        if ((r.status || 0) < 400 && (r.type === 'Script' || JS_CT.test(r.mime || '') || JS_EXT.test(r.url))) this._body(sid, p.requestId, r);
        break;
      }
      case 'Network.loadingFailed': {
        const r = this.reqs.get(sid + ':' + p.requestId); if (!r) break;
        r.error = p.errorText; r.blockedReason = p.blockedReason || null; r.canceled = !!p.canceled;
        break;
      }
    }
  }
  _body(sid, requestId, rec) {
    const pr = this._send(this._dbg(sid), 'Network.getResponseBody', { requestId }).then((r) => {
      const bytes = r.base64Encoded ? b64ToBytes(r.body) : new TextEncoder().encode(r.body);
      if (this.bodyBytes + bytes.length > 120e6) { rec.bodyError = 'skipped: body budget exhausted'; return; }
      this.bodyBytes += bytes.length;
      const k = stripHash(rec.url);
      if (!this.bodies.has(k)) this.bodies.set(k, { bytes, status: rec.status, mime: rec.mime, headers: rec.headers || {}, reencodedFromText: !r.base64Encoded });
      rec.bodyCaptured = bytes.length;
    }).catch((e) => { rec.bodyError = String((e && e.message) || e); });
    this.pending.push(pr);
  }
  /** shouldFetch(script) decides which script sources to read. */
  async finish(shouldFetch) {
    await Promise.allSettled(this.pending);
    let budget = 60e6;
    const need = this.scripts.filter((s) => shouldFetch(s));
    await pool(need, 5, async (s) => {
      try {
        const r = await this._send(this._dbg(s.sid), 'Debugger.getScriptSource', { scriptId: s.scriptId });
        const src = r && r.scriptSource;
        if (src == null) { s.sourceError = 'no source returned'; return; }
        if (src.length > 5e6 || budget - src.length < 0) { s.sourceError = 'skipped: too large / source budget exhausted'; return; }
        budget -= src.length; s.source = src;
      } catch (e) { s.sourceError = String((e && e.message) || e); }
    });
    return { scripts: this.scripts, reqs: [...this.reqs.values()], bodies: this.bodies, targets: this.targets, notes: this.notes };
  }
  async stop() {
    try { chrome.debugger.onEvent.removeListener(this._ev); chrome.debugger.onDetach.removeListener(this._det); } catch {}
    if (this.attached) { try { await chrome.debugger.detach({ tabId: this.tabId }); } catch {} }
    this.attached = false;
  }
}
