/**
 * Silent Send - Early Fetch Hook
 *
 * Injected synchronously BEFORE any page JavaScript to capture the
 * real fetch() and XMLHttpRequest before frameworks (Next.js, React)
 * can store their own references.
 *
 * Must be loaded as an external <script src="..."> (not inline)
 * because sites like claude.ai have strict CSP that blocks inline scripts.
 */
(function () {
  window.__ssOriginalFetch = window.fetch;
  window.__ssOriginalXHROpen = XMLHttpRequest.prototype.open;
  window.__ssOriginalXHRSend = XMLHttpRequest.prototype.send;
  window.__ssReady = false;

  window.fetch = function () {
    if (window.__ssReady && window.__ssInterceptFetch) {
      return window.__ssInterceptFetch.apply(this, arguments);
    }
    return window.__ssOriginalFetch.apply(this, arguments);
  };
})();
