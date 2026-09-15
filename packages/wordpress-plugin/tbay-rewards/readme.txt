=== TBAY Rewards ===
Contributors: tbaytk
Tags: analytics, heatmap, newsletter, rewards, woocommerce, loyalty, web3, affiliate
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 8.1
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Marketing automation, on-site analytics and TBAY token rewards for WordPress and WooCommerce.

== Description ==

TBAY Rewards connects your WordPress site to the TBAY Rewards platform, replacing
Mautic and myCred with one system that settles its rewards in a real crypto token.

**Analytics**

* Heatmaps of clicks, pointer movement and scroll depth
* Where customers came from, with revenue attributed back to the source
* Most-clicked, most-viewed and most-purchased products
* Abandoned carts with staged recovery emails

**Marketing**

* Newsletter signup with double opt-in and one-click unsubscribe
* Automations: when something happens to a customer, email or tag them
* Contacts, tags and segments

**Rewards**

* Points for purchases, signups, referrals, reviews and verified social shares
* Badges with tiers, ranks, daily-login streaks and leaderboards
* Point transfers between members, coupon codes and points-gated content
* Blog writers earn commission on products sold through their links

**TBAY token**

* Customers redeem points for TBAY on zkSync Era
* TBAY spends at any retailer on the TBAY network
* Bridge TBAY back to Ethereum
* Works with MetaMask and, via thirdweb, in-app and social wallets

== Installation ==

1. Upload the `tbay-rewards` folder to `/wp-content/plugins/`
2. Activate it through the **Plugins** menu
3. Go to **Settings → TBAY Rewards** and enter your platform URL, site key and API secret
4. Add `[tbay_rewards]` to a page for the member dashboard, and `[tbay_newsletter]` wherever you want signups

You need a TBAY Rewards platform instance. See the project documentation for
deploying one.

== Frequently Asked Questions ==

= Do I need WooCommerce? =

No. Without it you still get analytics, heatmaps, the newsletter, automations and
the full rewards programme. With it you also get cart tracking, order points,
writer commissions and TBAY store credit at checkout.

= Does this store my customers' data in WordPress? =

No. Analytics, contacts, points and token records live on your platform instance.
The plugin stores only its settings and small pointers linking WordPress users to
platform contacts. Uninstalling removes those pointers and leaves the customer
data intact.

= Is the site key safe to expose? =

Yes. It appears in your page source by design and can only write analytics. It
cannot read a report or move a single point. The API secret is the one that must
stay on your server.

= Can customers lose tokens? =

Redeeming signs a voucher that only the customer's own wallet can submit, so they
keep custody throughout. A voucher that is never submitted expires and the points
are returned automatically. When bridging to Ethereum, the interface shows
exactly how much will cross before anything is signed.

= Does it work with myCred? =

Yes. Enable the myCred bridge in settings and the platform balance is mirrored
into a myCred point type, so existing badges and ranks keep working.

= Is it GDPR friendly? =

IP addresses and user agents are stored only as salted hashes, raw cursor traces
are never kept, the newsletter uses double opt-in with a recorded consent date,
and a "wait for consent" mode collects nothing until your banner allows it.

== Screenshots ==

1. The member rewards dashboard: balance, rank, badges and wallet
2. Heatmap of a product page in the platform dashboard
3. Traffic sources and product engagement reports in wp-admin
4. The newsletter signup form
5. Writer commission links in the post editor

== Changelog ==

= 1.0.0 =
* Initial release: analytics, heatmaps, newsletter, automations, rewards,
  gamification, writer commissions, TBAY redemption and L2 to L1 bridging.

== Upgrade Notice ==

= 1.0.0 =
First release.
