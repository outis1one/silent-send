/**
 * Minimal browser API compatibility layer.
 *
 * Firefox exposes `browser.*` (Promise-based) and polyfills `chrome.*`.
 * Chrome only has `chrome.*` (callback-based, but storage/runtime are
 * Promise-based in MV3). This normalizes to whichever is available.
 */

const api =
  typeof browser !== 'undefined' && browser.runtime
    ? browser
    : typeof chrome !== 'undefined'
      ? chrome
      : null;

if (!api) {
  console.error('[Silent Send] No WebExtension API found');
}

export default api;
