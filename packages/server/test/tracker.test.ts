import { describe, it, expect } from 'vitest';
// @ts-expect-error — a plain-JS harness for a plain-JS tracker.
import { loadTracker } from './support/tracker-harness.mjs';

/**
 * The browser tracker, loaded under Node.
 *
 * Two properties nothing else can check: that it writes no identifier before
 * consent, and that what it reports as the page address carries no secrets
 * out of the query string.
 */

describe('consent gates identity, not just sending', () => {
  it('writes nothing at all before consent is given', () => {
    // The setting says "collect nothing until your consent banner calls
    // tbay.consent(true)". A 365-day cookie and a localStorage id for somebody
    // who never agreed to either is collection, whatever is or is not sent.
    const tracker = loadTracker({ requireConsent: true, priorConsent: false });
    expect(Object.keys(tracker.store)).toEqual([]);
    expect(tracker.written()).toEqual([]);
  });

  it('remembers the id the page was already using once consent arrives', () => {
    const tracker = loadTracker({ requireConsent: true, priorConsent: false });
    tracker.api.consent(true);
    expect(tracker.store.tbay_visitor).toBeTruthy();
    expect(tracker.written()).toContain('tbay_visitor');
  });

  it('forgets the identity when consent is withdrawn', () => {
    const tracker = loadTracker({ requireConsent: true, priorConsent: true });
    expect(tracker.store.tbay_visitor).toBeTruthy();
    tracker.api.consent(false);
    expect(tracker.store.tbay_visitor).toBeUndefined();
    expect(tracker.store.tbay_session).toBeUndefined();
  });

  it('still works immediately for a store that does not require consent', () => {
    const tracker = loadTracker({ requireConsent: false, priorConsent: false });
    expect(tracker.store.tbay_visitor).toBeTruthy();
  });
});

describe('the page address it reports', () => {
  const urlFor = (href: string): string => {
    const tracker = loadTracker({ requireConsent: false, priorConsent: false, href });
    return tracker.currentUrl();
  };

  it('drops a WooCommerce order key', () => {
    // Every guest checkout lands on order-received with a key that opens the
    // order — name, address, items — to anyone who reads it back out of the
    // analytics.
    expect(urlFor('https://shop.test/checkout/order-received/123/?key=wc_order_SECRET'))
      .toBe('https://shop.test/checkout/order-received/123/');
  });

  it('drops anything else that looks like a credential', () => {
    expect(urlFor('https://shop.test/account/?key=abc&login=jane&email=a@b.test'))
      .toBe('https://shop.test/account/');
    expect(urlFor('https://shop.test/p/1?preview_nonce=xyz&preview=true'))
      .toBe('https://shop.test/p/1');
  });

  it('drops the fragment, where some sites keep the session token', () => {
    expect(urlFor('https://shop.test/p/1#access_token=xyz')).toBe('https://shop.test/p/1');
  });

  it('keeps the campaign parameters analytics is actually for', () => {
    expect(urlFor('https://shop.test/p/1?utm_source=news&utm_campaign=spring&tb_ref=CODE9'))
      .toBe('https://shop.test/p/1?utm_source=news&utm_campaign=spring&tb_ref=CODE9');
  });
});
