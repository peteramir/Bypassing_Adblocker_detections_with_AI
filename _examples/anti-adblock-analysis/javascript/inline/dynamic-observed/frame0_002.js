window["__f__mwf6iypk.b8d"] = function(){with (this.s) {(async (u, { p, r, s }) => {try {r(u, s, [undefined,undefined,undefined,p.GM_info,p.GM]);} catch (e) {if (e.message && e.stack) {console.error("ERROR: Execution of script '_Disable Scrolling Down | \$1Space\$1 button | \$1Home\$1,\$1End\$1 buttons' failed! " + e.message);console.log(e.stack);} else {console.error(e);}}})(async function(define,module,exports,GM_info,GM) {
// ==UserScript==
// @name         _Disable Scrolling Down | "Space" button | "Home","End" buttons
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Prevents the space bar from scrolling the page down (like Page Down), but allows Shift+Space to scroll up and space to function in input fields, textareas, selects, and editable areas.
// @author       Grok
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @exclude      *://youtube.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    window.addEventListener('keydown', function(event) {
        // Check if the key is space (key code 32) and not shifted (shift+space scrolls up)
        if (event.key === ' ' && !event.shiftKey) {
            // Check if the active element is editable (input, textarea, select, contenteditable)
            const activeElement = document.activeElement;
            const isEditable = activeElement.tagName === 'INPUT' ||
                               activeElement.tagName === 'TEXTAREA' ||
                               activeElement.tagName === 'SELECT' ||
                               activeElement.isContentEditable;

            // If not editable and no ctrl/alt/meta modifiers, prevent default scrolling behavior
            if (!isEditable && !event.ctrlKey && !event.altKey && !event.metaKey) {
                event.preventDefault();
                event.stopPropagation();
            }
        }
    }, true); // Use capture phase to catch events early
})();
}, this)}
//# sourceURL=chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/userscript.html?name=_Disable-Scrolling-Down-%257C-%2522Space%2522-button-%257C-%2522Home%2522%252C%2522End%2522-buttons.user.js&id=0b237a8f-6bce-4f5d-b897-c8a297755cf8
}