# Anti-Adblock JS Forensic Collector

Local Manifest V3 extension (Chromium / Brave). Collects JavaScript and DOM evidence from the current page into one ZIP
for offline analysis by an AI model. It only observes: it never blocks, patches or bypasses anything, uses no remote
services, no analytics, and no external libraries.

## Install (Brave Desktop)
1. Unzip this folder somewhere permanent.
2. Open `brave://extensions/`, enable **Developer mode**.
3. **Load unpacked** and select the folder that contains `manifest.json`.
4. Pin the extension, open a page showing the anti-adblock message, click the icon.

## Use
- **Collect Current Page**: no reload. Inventories scripts/DOM now and uses the request log kept since the extension began watching the tab.
- **Reload & Capture**: installs a recorder on the site's domain, reloads the tab with cache bypass, waits ~5 s after load, then collects.
- **Deep capture** (checkbox, optional): adds the Chrome debugger for exact response bodies, eval'd code and loader stacks.
- Work runs in a background tab so it survives the popup closing. Reopen the popup and press **Export ZIP**.

## Folder structure
```
manifest.json
background.js          passive webRequest log + job start
popup.html/.css/.js    UI
worker.html/.js        orchestrator (collect, download, hash, build ZIP)
content/hook.js        MAIN-world recorder, registered only during Reload & Capture
lib/util.js            URL sanitizing, hashing, filenames, IndexedDB hand-off
lib/zip.js             ZIP writer (CRC32 + deflate-raw)
lib/page-funcs.js      functions injected into pages (collector, in-page fetch)
lib/deep.js            optional debugger (CDP) capture
```

## Permissions
| Permission | Why | Notes |
|---|---|---|
| host access `http(s)://*/*` (required) | inject the reader into tab + frames, cross-origin script fetch, observe requests | no request headers/cookies/bodies recorded |
| `scripting` (required) | run collector, register the recorder | |
| `webRequest` (required) | observe-only request metadata | no blocking |
| `storage` (required) | progress state + request log (session storage) | |
| `debugger` (optional) | Deep capture only | prompted when you tick the box; browser shows a debugging banner |

## What cannot be recovered
- Requests made before the extension was watching the tab (status, errors such as blocked-by-client, redirects, initiator origin, timings).
  Resource Timing partly compensates (sizes/durations; ~250-entry default buffer).
- Exact original response bytes, unless Deep + Reload recorded them. Otherwise bodies are re-requested and may differ.
- Which script loaded which script, `eval`/`new Function` code, self-removing inline scripts, worker internals: only with Reload & Capture and/or Deep capture.
- Closed shadow roots, sandboxed/about:blank frames, revoked `blob:` URLs.
The ZIP's `report.json` and `README.txt` list the limitations that applied to that run.

## Status
Syntax-checked, and the ZIP writer/URL sanitizer were exercised in Node. The extension has NOT been run in a browser
by its author; see the test checklist in the chat reply.
