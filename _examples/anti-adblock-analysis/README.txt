ANTI-ADBLOCK JAVASCRIPT FORENSIC ARCHIVE
=========================================
Site: www.fcportables.com
Page: https://www.fcportables.com/snap-video-translator-portable/
Collected: 2026-11-13T13:10:18.779Z
Mode: reload-and-capture + Deep capture (debugger)
Generated locally by Anti-Adblock JS Forensic Collector 1.0.0. Nothing was uploaded anywhere.
The collector only observes. It does not bypass, block or modify any detection.

COUNTS
  Discovered resources: 34 (first-party 21, third-party 13)
  Downloaded: 25    Failed: 0    Skipped: 9
  Inline scripts: 14 executable, 6 JSON/importmap, 0 other data blocks

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
  - Response bodies are re-requested by the extension (GET only, no cookies for cross-origin URLs) unless Deep capture + Reload recorded the original bytes. A re-request can differ from what the page originally received (personalised, rotating or expiring scripts, A/B variants).
  - Request status/initiator/error data exists only for requests the background monitor saw. Requests made before the extension was installed/enabled, before the service worker started observing this tab, or that were evicted from the 3000-entry per-tab log are not recoverable; Resource Timing (first ~250 entries by default) only partially compensates.
  - webRequest reports the initiating ORIGIN, not the initiating script. Which script loaded which script is only available in Deep capture (debugger initiator stacks).
  - Inline scripts that removed themselves from the DOM, eval()/new Function() code, and dynamic import() graphs are only observable with Reload & Capture (inline scripts) or Deep capture (all runtime-parsed code).
  - Dedicated/shared worker scripts are only identified via Reload & Capture hook, Deep capture, or webRequest records; code inside workers (including importScripts) is only captured with Deep capture.
  - Blob: URLs are only readable while still alive in a frame whose origin matches; revoked blobs cannot be recovered.
  - Frames that cannot be injected (sandboxed, about:blank/srcdoc, error pages, closed shadow roots) are not inspected. Open shadow roots are captured as HTML only.
  - Deep capture covers the main frame, same-process iframes and workers attached via auto-attach; coverage of out-of-process cross-origin iframes depends on the browser version. The debugger infobar and DevTools-like state may change how a page behaves.
  - The page is observed with the extension present. A site may behave differently when it detects extensions, hooks or a debugger.
  - First/third-party classification uses a heuristic registrable-domain rule (no public-suffix list).
  - Sensitive-looking URL query values, fragments and credentials are redacted in exported metadata; input values, textareas, CSRF/token meta tags and nonces are redacted in HTML snapshots. Inline scripts and downloaded files are stored as-is and may still contain page-specific identifiers.

SUGGESTED PROMPT FOR AN AI ASSISTANT
  "This archive was collected from a page showing an anti-adblock message. Read report.json first. Identify which
   script(s) detect the adblocker and how (bait elements, blocked-request probes, timing checks, API tampering...),
   how the blocking dialog is created and shown, and which DOM nodes it uses (dom/). Then propose a uBlock Origin
   scriptlet (preferred) or Tampermonkey userscript. Do not assume files that appear only in failed-resources.json."
