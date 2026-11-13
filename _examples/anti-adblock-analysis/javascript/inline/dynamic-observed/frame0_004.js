window["__f__mwf65tpd.5y"] = function(){with (this.s) {(async (u, { p, r, s }) => {try {r(u, s, [undefined,undefined,undefined,p.GM_info,p.GM]);} catch (e) {if (e.message && e.stack) {console.error("ERROR: Execution of script 'Remove ChatGPT URL Tracking' failed! " + e.message);console.log(e.stack);} else {console.error(e);}}})(async function(define,module,exports,GM_info,GM) {

// ==UserScript==
// @name         Remove ChatGPT URL Tracking
// @namespace    https://tampermonkey.net/
// @version      1.0
// @description  Remove utm_source=chatgpt.com from URLs
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const url = new URL(window.location.href);

    if (url.searchParams.get('utm_source') === 'chatgpt.com') {
        url.searchParams.delete('utm_source');

        const newUrl =
            url.pathname +
            url.search +
            url.hash;

        window.history.replaceState(
            window.history.state,
            '',
            newUrl
        );
    }
})();

}, this)}
//# sourceURL=chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/userscript.html?name=Remove-ChatGPT-URL-Tracking.user.js&id=ca42d273-e1e4-47cd-a8a0-93a0b00588ec
}