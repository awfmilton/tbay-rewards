/*!
 * TBAY Rewards tracker — vanilla ES5-compatible, no dependencies, no build step.
 *
 * Embed:
 *   <script src="https://rewards.example.com/tbay.js"
 *           data-key="tbp_..." data-endpoint="https://rewards.example.com" defer></script>
 *
 * Design notes
 *  - Everything is queued and flushed on a timer, on page hide, and when the
 *    queue fills. Nothing blocks rendering or navigation.
 *  - Pointer movement is sampled and reduced to normalised coordinates in the
 *    browser, so raw cursor traces never leave the device.
 *  - Consent-gated: with `data-require-consent`, nothing is sent until
 *    tbay.consent(true) is called.
 */
(function (window, document) {
  'use strict';

  if (window.tbay && window.tbay.__loaded) return;

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf('tbay.js') !== -1) return all[i];
    }
    return null;
  })();

  var settings = {
    key: attr('key', ''),
    endpoint: (attr('endpoint', '') || origin()).replace(/\/+$/, ''),
    heatmap: attr('heatmap', 'true') !== 'false',
    moveSampleMs: parseInt(attr('move-sample-ms', '120'), 10),
    flushMs: parseInt(attr('flush-ms', '8000'), 10),
    requireConsent: attr('require-consent', 'false') === 'true',
    sessionTimeoutMs: parseInt(attr('session-timeout-min', '30'), 10) * 60 * 1000,
    maxQueue: 40
  };

  function attr(name, fallback) {
    if (!script) return fallback;
    var value = script.getAttribute('data-' + name);
    return value === null || value === '' ? fallback : value;
  }

  function origin() {
    if (!script || !script.src) return '';
    try { return new URL(script.src).origin; } catch (e) { return ''; }
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  // First-party localStorage with an in-memory fallback, so private browsing or
  // a blocked storage API degrades to session-only tracking instead of breaking.

  var memory = {};

  function readStore(key) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? memory[key] : value;
    } catch (e) { return memory[key]; }
  }

  function writeStore(key, value) {
    memory[key] = value;
    try { window.localStorage.setItem(key, value); } catch (e) { /* quota or blocked */ }
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = '';
    for (var j = 0; j < 16; j++) hex += (bytes[j] + 0x100).toString(16).slice(1);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
           hex.slice(16, 20) + '-' + hex.slice(20);
  }

  var visitorId = readStore('tbay_visitor');
  if (!visitorId) { visitorId = uuid(); writeStore('tbay_visitor', visitorId); }

  /**
   * Mirror the visitor id into a first-party cookie.
   *
   * localStorage is invisible to the site's own server, and the storefront needs
   * this id at checkout to attribute the order to the session that earned it.
   * Without the cookie every order looks like direct traffic and writer
   * commissions never accrue.
   */
  function writeCookie(name, value, days) {
    try {
      var expires = new Date(Date.now() + days * 864e5).toUTCString();
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = name + '=' + encodeURIComponent(value) +
        '; Expires=' + expires + '; Path=/; SameSite=Lax' + secure;
    } catch (e) { /* cookies disabled — analytics still works, attribution does not */ }
  }

  function readCookie(name) {
    try {
      var match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
      return match ? decodeURIComponent(match[2]) : null;
    } catch (e) { return null; }
  }

  writeCookie('tbay_visitor', visitorId, 365);

  /**
   * Persist the trackable-link code on the storefront's own origin.
   *
   * The /r/ redirect sets its signed cookie on the API origin, which the shop's
   * server can never see. Capturing the code here, on the landing page, is what
   * lets checkout attribute the order to the writer whose link brought it.
   */
  (function persistLinkCode() {
    var code = linkCodeFromUrl();
    if (code) writeCookie('tbay_ref', code, 30);
  }());

  function currentSession() {
    var id = readStore('tbay_session');
    var last = parseInt(readStore('tbay_session_ts') || '0', 10);
    var now = Date.now();
    if (!id || !last || now - last > settings.sessionTimeoutMs) {
      id = uuid();
      writeStore('tbay_session', id);
    }
    writeStore('tbay_session_ts', String(now));
    return id;
  }

  var sessionId = currentSession();

  // ── Consent ───────────────────────────────────────────────────────────────

  var consented = !settings.requireConsent || readStore('tbay_consent') === '1';

  // ── Queue ─────────────────────────────────────────────────────────────────

  var queue = [];
  var heatQueue = {};
  var pendingCart = null;
  var flushTimer = null;

  function endpointUrl(path) { return settings.endpoint + path; }

  function payload() {
    var heat = [];
    for (var key in heatQueue) {
      if (!Object.prototype.hasOwnProperty.call(heatQueue, key)) continue;
      var batch = heatQueue[key];
      if (batch.samples.length > 0) heat.push(batch);
    }
    heatQueue = {};

    var body = {
      key: settings.key,
      visitor: visitorId,
      session: sessionId,
      url: location.href,
      referrer: document.referrer || null,
      linkCode: linkCodeFromUrl(),
      events: queue.splice(0, queue.length)
    };
    if (heat.length > 0) body.heatmap = heat;
    if (pendingCart) { body.cart = pendingCart; pendingCart = null; }
    return body;
  }

  function linkCodeFromUrl() {
    try {
      var params = new URLSearchParams(location.search);
      return params.get('tb_ref') || params.get('tbref') || null;
    } catch (e) { return null; }
  }

  function flush(useBeacon) {
    if (!consented || !settings.key) return;
    if (queue.length === 0 && isEmpty(heatQueue) && !pendingCart) return;

    var body = JSON.stringify(payload());
    var url = endpointUrl('/v1/collect');

    // sendBeacon survives the page unloading; fetch is used while the page lives
    // so we keep the x-tbay-key header and proper CORS.
    if (useBeacon && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }

    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tbay-key': settings.key },
        body: body,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors'
      })['catch'](function () { /* analytics must never surface an error */ });
    } catch (e) { /* ignore */ }
  }

  function isEmpty(obj) {
    for (var key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) return false;
    return true;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = window.setTimeout(function () {
      flushTimer = null;
      flush(false);
    }, settings.flushMs);
  }

  function push(event) {
    if (!consented) return;
    event.occurredAt = new Date().toISOString();
    if (!event.url) event.url = location.href;
    queue.push(event);
    if (queue.length >= settings.maxQueue) flush(false);
    else scheduleFlush();
  }

  // ── Heatmap capture ───────────────────────────────────────────────────────

  function docHeight() {
    var body = document.body;
    var html = document.documentElement;
    return Math.max(
      body ? body.scrollHeight : 0, body ? body.offsetHeight : 0,
      html ? html.clientHeight : 0, html ? html.scrollHeight : 0, html ? html.offsetHeight : 0
    ) || 1;
  }

  function heatBatch(kind) {
    var key = kind + '|' + location.pathname;
    if (!heatQueue[key]) {
      heatQueue[key] = {
        page: location.href,
        kind: kind,
        samples: [],
        docHeight: docHeight(),
        viewportWidth: window.innerWidth
      };
    }
    return heatQueue[key];
  }

  /** Normalise a page-absolute point to 0..1 of document width/height. */
  function addSample(kind, pageX, pageY) {
    if (!settings.heatmap || !consented) return;
    var width = Math.max(document.documentElement.clientWidth, 1);
    var height = docHeight();
    var batch = heatBatch(kind);
    if (batch.samples.length >= 800) return;
    batch.samples.push({
      x: Math.round((pageX / width) * 10000) / 10000,
      y: Math.round((pageY / height) * 10000) / 10000
    });
  }

  var lastMove = 0;
  function onMove(event) {
    var now = Date.now();
    if (now - lastMove < settings.moveSampleMs) return;
    lastMove = now;
    addSample('move', event.pageX, event.pageY);
  }

  var maxScroll = 0;
  function onScroll() {
    var scrolled = (window.pageYOffset || document.documentElement.scrollTop) + window.innerHeight;
    var depth = Math.min(1, scrolled / docHeight());
    if (depth > maxScroll) maxScroll = depth;
  }

  function flushScrollDepth() {
    if (!settings.heatmap || maxScroll <= 0) return;
    var batch = heatBatch('scroll');
    batch.samples.push({ x: 0, y: Math.round(maxScroll * 10000) / 10000 });
    maxScroll = 0;
  }

  // ── Automatic event capture ───────────────────────────────────────────────

  function closestAttr(element, name) {
    var node = element;
    while (node && node !== document.documentElement) {
      if (node.getAttribute) {
        var value = node.getAttribute(name);
        if (value) return { value: value, node: node };
      }
      node = node.parentNode;
    }
    return null;
  }

  function describe(element) {
    if (!element || !element.tagName) return '';
    var parts = [element.tagName.toLowerCase()];
    if (element.id) parts.push('#' + element.id);
    if (element.className && typeof element.className === 'string') {
      var first = element.className.trim().split(/\s+/)[0];
      if (first) parts.push('.' + first);
    }
    return parts.join('');
  }

  function onClick(event) {
    var target = event.target;
    if (!target || target.nodeType !== 1) return;

    addSample('click', event.pageX, event.pageY);

    var product = closestAttr(target, 'data-tbay-product');
    var anchor = target.closest ? target.closest('a[href]') : null;
    var text = (target.textContent || '').trim().slice(0, 120);

    if (product) {
      push({
        type: 'product_click',
        productRef: product.value,
        props: { text: text, selector: describe(target) }
      });
      return;
    }

    if (anchor) {
      var href = anchor.getAttribute('href') || '';
      var shareCode = anchor.getAttribute('data-tbay-share');
      if (shareCode) {
        push({ type: 'share_click', linkCode: shareCode, props: { href: href } });
        return;
      }

      var isExternal = /^https?:\/\//i.test(href) && href.indexOf(location.host) === -1;
      var inArticle = anchor.closest && anchor.closest('article, .entry-content, .post-content');
      if (inArticle || isExternal) {
        push({
          type: 'blog_link_click',
          linkCode: linkCodeOf(href),
          props: { href: href, text: text, external: isExternal, selector: describe(anchor) }
        });
        return;
      }
    }

    push({ type: 'click', props: { text: text, selector: describe(target) } });
  }

  function linkCodeOf(href) {
    try {
      var url = new URL(href, location.href);
      var match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
      if (match) return match[1];
      return url.searchParams.get('tb_ref');
    } catch (e) { return null; }
  }

  function pageviewProduct() {
    var meta = document.querySelector('[data-tbay-product-page]');
    if (!meta) return null;
    return {
      productRef: meta.getAttribute('data-tbay-product-page'),
      name: meta.getAttribute('data-tbay-product-name'),
      priceCents: parseInt(meta.getAttribute('data-tbay-product-price') || '', 10) || null,
      imageUrl: meta.getAttribute('data-tbay-product-image'),
      url: location.href
    };
  }

  var lastPath = null;

  function pageview() {
    if (location.href === lastPath) return;
    lastPath = location.href;
    sessionId = currentSession();
    push({ type: 'pageview', props: { title: document.title } });

    var product = pageviewProduct();
    if (product && product.productRef) {
      push({
        type: 'product_view',
        productRef: product.productRef,
        product: {
          name: product.name,
          priceCents: product.priceCents,
          imageUrl: product.imageUrl,
          url: product.url
        }
      });
    }
  }

  // ── SPA navigation ────────────────────────────────────────────────────────

  function patchHistory(method) {
    var original = window.history[method];
    if (!original) return;
    window.history[method] = function () {
      var result = original.apply(this, arguments);
      window.setTimeout(function () { flushScrollDepth(); pageview(); }, 0);
      return result;
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  var api = {
    __loaded: true,
    visitorId: function () { return visitorId; },
    sessionId: function () { return sessionId; },

    /** Record any event. tbay.track('newsletter_view') or tbay.track('custom', {...}). */
    track: function (type, props, extra) {
      var event = { type: type, props: props || {} };
      if (extra) for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) event[key] = extra[key];
      push(event);
    },

    product: function (productRef, info) {
      push({ type: 'product_view', productRef: productRef, product: info || {} });
    },

    addToCart: function (productRef, valueCents) {
      push({ type: 'add_to_cart', productRef: productRef, valueCents: valueCents || null });
    },

    /** Report the whole cart so abandonment tracking has something to recover. */
    cart: function (cartToken, items, currency, checkoutUrl) {
      pendingCart = {
        cartToken: cartToken,
        items: items || [],
        currency: currency || undefined,
        checkoutUrl: checkoutUrl || null
      };
      scheduleFlush();
    },

    /** Attach an identity so later reports and rewards find this person. */
    identify: function (traits) {
      if (!consented || !settings.key) return Promise.resolve(null);
      var body = traits || {};
      body.key = settings.key;
      body.visitor = visitorId;
      return fetch(endpointUrl('/v1/identify'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tbay-key': settings.key },
        body: JSON.stringify(body),
        credentials: 'omit',
        mode: 'cors'
      }).then(function (response) { return response.ok ? response.json() : null; })
        ['catch'](function () { return null; });
    },

    subscribe: function (fields) {
      var body = fields || {};
      body.key = settings.key;
      body.visitor = visitorId;
      return fetch(endpointUrl('/v1/newsletter/subscribe'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tbay-key': settings.key },
        body: JSON.stringify(body),
        credentials: 'omit',
        mode: 'cors'
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error(data.message || 'Subscription failed');
          return data;
        });
      });
    },

    consent: function (granted) {
      consented = granted !== false;
      writeStore('tbay_consent', consented ? '1' : '0');
      if (consented) { pageview(); scheduleFlush(); }
      else { queue.length = 0; heatQueue = {}; pendingCart = null; }
    },

    flush: function () { flushScrollDepth(); flush(false); }
  };

  // Replay anything queued before the script finished loading:
  //   window.tbay = window.tbay || []; tbay.push(['track', 'x']);
  var preload = window.tbay;
  window.tbay = api;
  if (preload && preload.length) {
    for (var i = 0; i < preload.length; i++) {
      var call = preload[i];
      if (call && api[call[0]]) api[call[0]].apply(api, call.slice(1));
    }
  }

  // ── Wire up ───────────────────────────────────────────────────────────────

  if (!settings.key) {
    if (window.console) console.warn('[tbay] missing data-key; tracker idle');
    return;
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { flushScrollDepth(); flush(true); }
  });
  window.addEventListener('pagehide', function () { flushScrollDepth(); flush(true); });

  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', function () { flushScrollDepth(); pageview(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pageview);
  } else {
    pageview();
  }
}(window, document));
