window["__f__mwf68itx.jtt"] = function(){with (this.s) {(async (u, { p, r, s }) => {try {r(u, s, [undefined,undefined,undefined,p.GM_info,p.GM]);} catch (e) {if (e.message && e.stack) {console.error("ERROR: Execution of script '_Disable Animations + Removing background-image' failed! " + e.message);console.log(e.stack);} else {console.error(e);}}})(async function(define,module,exports,GM_info,GM) {
// ==UserScript==
// @name         _Disable Animations + Removing background-image
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Forces "transition: none !important" on all websites to disable animations.
// @author       User
// @match        *://*/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // Create a style element to inject the CSS rule
    const style = document.createElement('style');
    style.type = 'text/css';
    style.textContent = `* { transition: none !important; }`;
    // style.textContent = `* { background-image: none !important; }`;



    // Append the style element to the document head
    document.head.appendChild(style);

})();

}, this)}
//# sourceURL=chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/userscript.html?name=_Disable-Animations-%252B-Removing-background-image.user.js&id=bb82e394-0567-4275-aa2f-0346a6461a2a
}