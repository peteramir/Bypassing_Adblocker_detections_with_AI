import { loadZip } from './lib/util.js';
const $ = (id) => document.getElementById(id);
let tab = null;

function setMsg(t, cls) { const m = $('msg'); m.textContent = t || ''; m.className = 'msg' + (cls ? ' ' + cls : ''); }
function render(job) {
  const running = job && job.state === 'running' && Date.now() - job.startedAt < 15 * 60e3;
  const mine = job && tab && job.tabId === tab.id;
  $('progress').hidden = !(running || (job && job.state === 'error' && mine));
  if (job && mine) {
    $('phase').textContent = job.state === 'error' ? 'Failed: ' + (job.error || '') : job.phase || '';
    $('barFill').style.width = (job.pct || 0) + '%';
    $('sDisc').textContent = job.discovered || 0; $('sDown').textContent = job.downloaded || 0; $('sFail').textContent = job.failed || 0;
    $('subStats').textContent = `${job.inline || 0} inline scripts · ${job.skipped || 0} skipped (not JS / not replayed)`;
  }
  const busy = running;
  $('btnCurrent').disabled = busy || !tab || !tab.ok; $('btnReload').disabled = busy || !tab || !tab.ok;
  $('btnExport').disabled = !(job && job.state === 'done');
  if (job && job.state === 'done') setMsg('Ready: ' + job.zipName + ' (' + Math.round((job.zipSize || 0) / 1024) + ' KB)', 'ok');
  else if (job && job.state === 'error' && mine) setMsg('Collection failed. See details above.', 'err');
  else if (busy) setMsg('Collecting in a background tab. You can close this popup and reopen it later.');
}

async function start(mode) {
  setMsg('');

  const deep = $('deep').checked;

  const r = await chrome.runtime.sendMessage({
    type: 'start',
    tabId: tab.id,
    mode,
    deep,
    domain: tab.host
  });

  if (!r || !r.ok) {
    setMsg((r && r.error) || 'Could not start.', 'err');
  }
}

async function exportZip() {
  try {
    const z = await loadZip();
    if (!z) { setMsg('No archive found. Run a collection first.', 'err'); return; }
    const url = URL.createObjectURL(z.blob);
    const a = document.createElement('a'); a.href = url; a.download = z.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setMsg('Saved ' + z.name + ' to your downloads.', 'ok');
  } catch (e) { setMsg('Export failed: ' + e.message, 'err'); }
}

(async () => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '', ok = false;
  try { const u = new URL(t.url); ok = /^https?:$/.test(u.protocol); host = u.hostname; } catch {}
  tab = { id: t && t.id, ok, host };
  $('domain').textContent = ok ? host : 'This page type can’t be collected (open a normal http/https page).';
  $('btnCurrent').addEventListener('click', () => start('current'));
  $('btnReload').addEventListener('click', () => start('reload'));
  $('btnExport').addEventListener('click', exportZip);
  const { job } = await chrome.storage.session.get('job');
  render(job);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && ch.job) render(ch.job.newValue); });
})();
