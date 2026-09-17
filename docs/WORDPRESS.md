# WordPress plugin

Install `packages/wordpress-plugin/tbay-rewards` as a normal plugin (upload the
folder to `wp-content/plugins/` or zip it and use **Plugins → Add New → Upload**).

Then **Settings → TBAY Rewards**:

| Field | Value |
|---|---|
| Platform URL | Your `PUBLIC_URL` |
| Site key | `tbp_…` from `tenant:create` |
| API secret | `tbs_….…` from `tenant:create` |

Leaving the secret field blank on a later save keeps the existing one, so
re-saving the page never wipes a credential you cannot see.

---

## Shortcodes

| Shortcode | Renders |
|---|---|
| `[tbay_newsletter]` | Signup form with double opt-in |
| `[tbay_rewards]` | Member dashboard: balance, rank, badges, wallet, redemption, bridge, history |
| `[tbay_points]` | Just the balance, for a header or menu |
| `[tbay_badges]` | Badge wall |
| `[tbay_bridge]` | The L2 → L1 bridge on its own |
| `[tbay_leaderboard]` | Top members by lifetime points, one board per currency |
| `[tbay_share]` | Share buttons that pay when someone else clicks the link |
| `[tbay_link product="123"]…[/tbay_link]` | A tracked product link earning the author commission |
| `[tbay_my_commissions]` | A writer's own clicks, orders and earnings |

Attributes:

```
[tbay_newsletter list="newsletter" title="Join us" button="Subscribe" name_field="yes"]
[tbay_share networks="x,facebook,linkedin,copy" url="https://…"]
[tbay_leaderboard limit="10"]
[tbay_leaderboard limit="10" point_type="status"]
```

Two admin screens were added alongside the rest: **Currencies**, and
**Privacy** — retention windows and the record of erasures carried out.
Erasing one person is done from their own customer page, where whoever is
doing it can see who they are erasing.

**Reports** has its own screen: pick what the report is about, what to group
by and what to measure, then have it emailed daily, weekly or monthly. The
lists of what can be grouped and measured come from the platform rather than
being hard-coded in the plugin, so a measure added server-side appears without
a plugin update.

**Merging a duplicate** is done from the customer page of the record that
survives, so "which one am I keeping" is never a guess. Possible duplicates are
listed there when the platform has found any.

**Your own fields** are defined on the Privacy screen and edited on each
customer's page, with the control matching the type — a date picker for a date,
a dropdown for a list. That is the point of declaring the type: a free-text box
is how "ON", "on" and "Ontario" become three segments.

**Writing an email** is done with blocks rather than HTML. Open a template on
the Email screen, or a draft send on the Segments & sends screen and click
"Write it": add a heading, a paragraph, a button, a picture, a row of products
or the recipient's points balance, and drag the order about. The list of block
types and their fields comes from the platform, so a block added server-side
appears without a plugin update.

Any block can be limited to a segment, or hidden from one. That is how one
message serves two audiences — a VIP paragraph above the same three products
everybody gets — instead of sending two. **Preview** renders it, and naming a
contact renders what *that person* would get, so a conditional block can be
checked rather than guessed at.

A send either names a template or carries its own message. Leave the template
box blank when preparing a send and write the message on the send itself: the
monthly newsletter is a one-off, and a template list that is really a send
history helps nobody.

Templates written by hand keep working. Editing one shows the HTML it was
written in, with a link to rebuild it from blocks — which replaces the HTML,
because generated HTML cannot be turned back into blocks.

**Email topics** live at the bottom of the Email screen. They are what a
recipient chooses between on the preference page every marketing email links
to; a store that defines none keeps exactly today's behaviour. The same panel
shows how many people, in the last month, changed a topic or paused rather
than leaving — which is the number that says whether the page is earning its
keep.

A retailer running more than one currency puts one board up per currency:
`point_type` names it, and omitting it gives the default. The member dashboard
shows every currency on its own, so there is nothing to configure there.


There is also a **TBAY newsletter signup** block in the editor's inserter, with
list, heading, description and button label configurable in the sidebar.

---

## What it does automatically

With WooCommerce active:

- Pushes the cart on every page so abandonment tracking has something to recover
- Captures the attribution cookie at checkout onto the order
- Reports paid orders, awards points, accrues writer commission
- Voids commissions and claws back points on refund
- Offers TBAY store credit at cart and checkout, and applies it as a discount
- Marks product tiles so clicks are attributed to the right product

Always:

- Loads the tracker with your site key
- Syncs WordPress users to platform contacts (`external_ref` is the user id, so a
  customer who changes their email address stays the same contact)
- Counts one visit per member per day toward their streak
- Sets a first-party visitor cookie, which is what lets checkout attribute an
  order back to the writer link that brought it
- Serves `/wp-json/tbay/v1/webhook` for signed platform callbacks

---

## Writer commission links

Authors get a **TBAY commission links** box in the post editor. Enter a product
id, press **Create link**, and the shortcode is copied to the clipboard.

Links are minted once per (post, product) and cached in post meta, so rendering a
post never waits on the platform. If the platform is unreachable the link still
renders — just untracked — rather than breaking the page.

The default rate is **Settings → TBAY Rewards → Writer commission** in basis
points (500 = 5%).

---

## myCred bridge

If myCred is installed, **Settings → TBAY Rewards → myCred** can mirror the
platform balance into a myCred point type, so existing badges, ranks and displays
keep working.

TBAY Rewards stays the system of record. The other direction would mean two
ledgers that can disagree about what a customer is owed, which is exactly the
problem the points ledger exists to prevent. Points earned through a myCred hook
are mirrored *into* the platform ledger.

---

## Hooks for theme developers

```php
// After an order has been reported to the platform.
add_action( 'tbay_rewards_order_synced', function ( WC_Order $order, array $result ) {
    // $result['points_awarded'], $result['commissions']
}, 10, 2 );

// Any verified webhook from the platform.
add_action( 'tbay_rewards_webhook', function ( string $topic, array $data ) {}, 10, 2 );

// One specific topic.
add_action( 'tbay_rewards_webhook_points_awarded', function ( array $data ) {} );
```

The plugin instance is available via `tbay_rewards()`.

### Receiving platform events

Register the site's webhook endpoint once, from the platform:

```bash
npm run cli -- webhook:add --slug my-shop \
  --url https://my-shop.example/wp-json/tbay/v1/webhook \
  --secret "$(openssl rand -hex 32)" \
  --topic points_awarded --topic store_credit_issued
```

Use the same secret in **Settings → TBAY Rewards**. Deliveries are signed, and
the plugin rejects anything older than five minutes.

---

## Theming

Components use the tbay.tk design tokens and carry their own dark surface, so
they look correct dropped into a light theme. Every value is a custom property on
`.tbay-root`:

```css
.tbay-root {
    --tbay-primary: #00d4d4;
    --tbay-surface: #141b2d;
    --tbay-text:    #e4eaf5;
    --tbay-r-lg:    16px;
}
```

Redefine those and the whole component set follows. There is no `!important`
anywhere, so ordinary theme CSS can override anything it needs to.

---

## Wallets on phones

A phone browser cannot talk to a wallet extension, so the rewards panel offers a
deep link into the MetaMask browser instead of dead-ending on "install
MetaMask".

Setting `THIRDWEB_CLIENT_ID` on the platform additionally enables thirdweb
in-app wallets, so a customer can sign in with Google and hold TBAY without ever
installing anything. thirdweb v5 is ESM-only, so it is loaded with a dynamic
import at the moment a wallet action happens — no build step, and nothing is
downloaded for shoppers who never touch Web3.

## Privacy and consent

Enable **Wait for consent** and nothing is collected until your banner calls:

```js
window.tbay.consent( true );
```

Uninstalling removes the plugin's settings and local pointers. It deliberately
leaves platform-side points, commissions and contacts alone — deleting a plugin
should not destroy a customer's balance.
