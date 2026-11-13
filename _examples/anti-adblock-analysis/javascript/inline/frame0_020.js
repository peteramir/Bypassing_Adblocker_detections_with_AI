
        document.addEventListener('DOMContentLoaded', function () {
            var links = document.querySelectorAll('a');
            links.forEach(function (link) {
                var url = link.getAttribute('href');
                var parsedUrl = new URL(url, window.location.href);
                if (parsedUrl.hostname !== window.location.hostname) {
                    link.setAttribute('target', '_blank');
                    link.setAttribute('rel', 'noopener');
                }
            });
        });
    