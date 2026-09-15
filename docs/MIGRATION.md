# Migrating from Mautic, myCred and flagswag

Importers for retailers moving an existing audience across. All of them are
idempotent and support `--dry-run`, because a migration you cannot rehearse is
one nobody runs on a live store.

Always rehearse first:

```bash
npm run import -- mautic --tenant my-shop --file contacts.csv --dry-run
```

A dry run parses and validates the entire file and reports exactly what would
happen, without writing a single row.

---

## Mautic contacts

Export from **Mautic → Contacts → Export → CSV**.

```bash
npm run import -- mautic --tenant my-shop --file contacts.csv --dry-run
npm run import -- mautic --tenant my-shop --file contacts.csv
```

Recognised columns (all optional except an email):

| Column | Becomes |
|---|---|
| `email` | Contact email and the cross-retailer member identity |
| `firstname` / `lastname` / `name` | Contact name |
| `phone`, `country` | Contact fields |
| `tags` (pipe- or comma-separated) | Contact tags |
| `dnc_status` / `do_not_contact` / `status` | Subscription state |
| `date_added` / `date_identified` | **Original consent date** |
| `id` | `external_ref` as `mautic:<id>` |
| anything else | Kept in contact attributes |

**Consent is preserved, not reset.** The original opt-in date carries across,
because re-consenting an existing list is the fastest way to lose it, and that
timestamp is your evidence for continuing to mail them. Anyone Mautic recorded as
unsubscribed or bounced stays that way and is excluded from every send.

### What does not come across

Campaign definitions. Mautic's canvas does not map onto this platform's
trigger → conditions → actions model, and a lossy automatic translation of the
logic that decides who gets emailed is worse than rebuilding it deliberately. See
`installDefaultAutomations` for the starting set.

---

## myCred balances, badges and ranks

Export a CSV with at least `user_email` and `balance`.

```bash
npm run import -- mycred --tenant my-shop --file balances.csv --dry-run
npm run import -- mycred --tenant my-shop --file balances.csv
```

| Column | Becomes |
|---|---|
| `user_email` | Contact and member identity |
| `balance` / `creds` / `points` | A single opening ledger entry |
| `user_id` | `external_ref`, so WordPress users link up |
| `display_name` | Contact name |
| `badges` (pipe- or comma-separated slugs) | Badge awards |

Balances land as **one opening entry per member**, not a replayed history. The
platform's ledger is the system of record from the cutover forward, and an
opening balance is auditable without pretending to reconstruct years of myCred
log rows it never saw. The entry is keyed on the contact, so re-running the
import never tops anybody up twice.

Ranks are recalculated from lifetime points afterwards, so members keep their
standing. Badge slugs are only granted if a badge with that key already exists —
importing would otherwise invent badge definitions with no criteria, which nobody
could ever earn again.

---

## flagswag writer links and commissions

```bash
npm run import -- flagswag-links --tenant flagswag --file links.csv
npm run import -- flagswag-commissions --tenant flagswag --file commissions.csv
```

Links are recreated **with their original codes**, so `/go/MAPLE4K7Q` already
published in a blog post or shared on social keeps working. That is the whole
reason to import rather than start fresh — an affiliate link that 404s is a
broken promise to the writer. Historical click totals carry over so reports have
no cliff at the cutover.

Commission rows import as `paid` unless the export says otherwise: a migration
must not re-open a payout that has already been settled.

Export shapes:

```
# links.csv
code,target_url,owner_email,post_id,product_id,rate_bps,clicks

# commissions.csv
order_ref,owner_email,amount_cents,subtotal_cents,status,created_at
```

---

## Suggested order

1. **Contacts first** — `mautic`, so everyone exists before anything references them
2. **Balances** — `mycred`, which finds those contacts by email
3. **Links** — `flagswag-links`, which creates writer contacts as needed
4. **Commissions** — `flagswag-commissions`

Then verify:

```bash
curl -s -H "Authorization: Bearer $SECRET" https://rewards.example.com/v1/reports/rewards | jq
curl -s -H "Authorization: Bearer $SECRET" https://rewards.example.com/v1/newsletter/lists | jq
```

---

## Running both systems during a cutover

Safe, with one rule: **decide which system awards points, and let only that one
do it.** Both awarding simultaneously means two ledgers that disagree about what
a customer is owed, which is the exact problem the ledger exists to prevent.

If you keep myCred for badges and display, enable the plugin's myCred bridge
(**Settings → TBAY Rewards → myCred**). It mirrors the platform's balance into a
myCred point type, keeping the platform as the system of record.
