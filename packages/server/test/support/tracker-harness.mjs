import fs from 'node:fs';

/**
 * Run the browser tracker under Node with just enough DOM to load.
 *
 * The tracker has no build step and no test framework of its own, and the two
 * things most worth pinning about it — that it writes no identifier before
 * consent, and that it does not ship secrets out of the query string — are
 * both invisible from the server side.
 */

export function loadTracker({ requireConsent, priorConsent, href }) {
  const store = {};
  if (priorConsent) store.tbay_consent = '1';
  const cookies = [];

  const dataset = { key: 'tbp_test', endpoint: 'https://api.test' };
  if (requireConsent) dataset.requireConsent = '1';

  const script = {
    dataset,
    src: 'https://api.test/tbay.js',
    getAttribute: (name) => {
      const map = {
        'data-key': dataset.key,
        'data-endpoint': dataset.endpoint,
        'data-require-consent': requireConsent ? 'true' : null,
      };
      return map[name] ?? null;
    },
  };

  const doc = {
    referrer: '',
    readyState: 'complete',
    currentScript: script,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [script],
    documentElement: { scrollHeight: 1000, clientHeight: 800 },
    body: { scrollHeight: 1000 },
    visibilityState: 'visible',
    title: 'test',
  };
  Object.defineProperty(doc, 'cookie', {
    get: () => cookies.filter((c) => !/=;\s*Expires=Thu, 01 Jan 1970/.test(c)).join('; '),
    set: (v) => { cookies.push(v); },
  });

  const loc = new URL(href || 'https://shop.test/p/1?utm_source=news&key=wc_order_SECRET');
  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    addEventListener() {}, removeEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    location: loc, document: doc, navigator: { sendBeacon: () => true, userAgent: 'test' },
    innerWidth: 1200, innerHeight: 800, scrollY: 0, pageYOffset: 0,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    URL, URLSearchParams,
    history: { pushState() {}, replaceState() {} },
    performance: { now: () => 0, getEntriesByType: () => [] },
    screen: { width: 1200, height: 800 },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  win.window = win;

  global.window = win;
  global.document = doc;

  const code = fs.readFileSync(new URL('../../../tracker/tbay.js', import.meta.url), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', 'navigator', 'fetch', 'setTimeout',
    'clearTimeout', 'URL', 'URLSearchParams', code)(
    win, doc, loc, win.navigator, win.fetch, win.setTimeout, win.clearTimeout, URL, URLSearchParams);

  const written = () => cookies.filter((c) => !/Expires=Thu, 01 Jan 1970/.test(c)).map((c) => c.split('=')[0]);
  return {
    store,
    cookies,
    written,
    api: win.tbay,
    /** What the tracker would report as this page's address. */
    currentUrl: () => win.tbay.__currentUrl(),
  };
}
