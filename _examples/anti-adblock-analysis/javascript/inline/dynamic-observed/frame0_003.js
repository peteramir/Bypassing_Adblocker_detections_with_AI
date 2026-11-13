window["__f__mwezx558.g1r"] = function(){with (this.s) {(async (u, { p, r, s }) => {try {r(u, s, [undefined,undefined,undefined,p.GM_info,p.GM]);} catch (e) {if (e.message && e.stack) {console.error("ERROR: Execution of script '_Page Navigator (Ctrl+Up/Down)' failed! " + e.message);console.log(e.stack);} else {console.error(e);}}})(async function(define,module,exports,GM_info,GM) {
// ==UserScript==
// @name         _Page Navigator (Ctrl+Up/Down)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  استخدم Ctrl+Down للصفحة اللي بعدها و Ctrl+Up للصفحة اللي فاتت، سواء كان الرقم فى ?page= أو فى مسار اللينك زى /page/2/
// @author       you
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function goToPage(delta) {
        const url = new URL(window.location.href);
        const params = url.searchParams;

        // الحالة الأولى: فيه ?page= فى الكويري سترنج
        if (params.has('page')) {
            let currentPage = parseInt(params.get('page'), 10);
            if (isNaN(currentPage)) {
                return;
            }

            let newPage = currentPage + delta;
            if (newPage < 1) {
                return;
            }

            params.set('page', newPage);
            url.search = params.toString();
            window.location.href = url.toString();
            return;
        }

        // الحالة الثانية: الرقم فى المسار نفسه زى /page/2/
        const pathRegex = /\/page\/(\d+)(\/?)/i;
        const match = url.pathname.match(pathRegex);

        if (match) {
            let currentPage = parseInt(match[1], 10);
            if (isNaN(currentPage)) {
                return;
            }

            let newPage = currentPage + delta;
            if (newPage < 1) {
                return;
            }

            const trailingSlash = match[2] || '';
            url.pathname = url.pathname.replace(
                pathRegex,
                '/page/' + newPage + trailingSlash
            );

            window.location.href = url.toString();
            return;
        }

        // لو مفيش page لا فى الكويري ولا فى المسار، متعملش حاجة
    }

    document.addEventListener('keydown', function (e) {
        // نتأكد إن الكيبورد مش بيدوس جوه textbox أو textarea
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) {
            return;
        }

        if (e.ctrlKey && !e.shiftKey && !e.altKey) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                goToPage(1); // next
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                goToPage(-1); // previous
            }
        }
    });
})();
}, this)}
//# sourceURL=chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/userscript.html?name=_Page-Navigator-Ctrl%252BUp%252FDown.user.js&id=350856a5-8e70-457a-be03-edb49d8412bc
}