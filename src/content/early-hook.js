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
  // Claude Code (claude.ai/code) streams real file paths, shell commands, and
  // tool-call traffic through the same HTTP surface as user messages. Any
  // substitution there corrupts tool execution. We deliberately stay out of
  // it entirely so the extension stays robust to API shape changes — the user
  // handles redaction manually on this one app.
  if (
    location.hostname === 'claude.ai' &&
    /^\/code(\/|$)/.test(location.pathname)
  ) {
    window.__ssSkipHost = true;
    return;
  }

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
