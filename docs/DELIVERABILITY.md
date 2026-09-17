# How a delivery failure is classified

The specification for bounce handling. `packages/server/src/services/bounce-table.ts`
is the machine-readable form of this document;
`packages/server/test/support/bounce-corpus.ts` is the corpus of real provider
replies that the table must reproduce, and the thing to review and disagree
with.

Five rewrites of the classifier came before this. Every one was a pile of
regular expressions over the reply text with a precedence order between them,
and every adversarial round found a reply where two patterns overlapped and the
wrong one won. The ordering was never the bug. Not having written down what the
answer should be was.

## The decision, in two steps

**Step one: what is this reply about?** Decided by the tables, every row of
which cites the provider that sends that wording.

**Step two: given that, what do we do?** Decided by eight lines with no
exceptions in them.

Separating the two is the point. Step one is where judgement and provider
quirks live; step two is policy, and it is short enough to read in one go.

## Step one: the subjects

| Subject | Means |
|---|---|
| `connection` | No usable reply arrived: sockets, TLS, our own timeouts, the receiving system's own faults |
| `credentials` | The relay refused **us** — authentication, not delivery |
| `sender` | Our address, our domain, our reputation |
| `message` | This particular message: content, size, encoding |
| `capacity` | The mailbox, or the system, is full |
| `mailbox` | The recipient's mailbox does not exist or cannot receive |
| `domain` | The destination **domain**, not one mailbox |
| `deferral` | "Not now" — a greylist, a throttle |
| `unknown` | Nothing in the reply identifies what it is about |

Three of these were separated out because rounds of review kept arguing about
them without settling:

- **`domain`** exists because Exim's `550 Unrouteable address` means the domain
  has no MX — permanent, as far as Exim can tell — but a recipient provider
  with a broken DNS record produces it for every address at that domain at
  once. Read as a dead mailbox it suppressed all of them forever on the first
  attempt; read as an ordinary deferral a genuinely dead domain bounced on
  every broadcast. It is retried *and* allowed to count, so it ends in the
  thirty-day lapsing suppression rather than a permanent one.
- **`deferral`** exists because it must never count toward writing an address
  off at *any* severity. Folded into `unknown` it inherited the attempt budget,
  so a wording-only greylist with no reply code ended in a suppression.
- **`credentials`** is separate from `connection` because it is the failure
  that hits every address in the queue identically and is entirely ours.

## Step two: the policy

```
severity 4 (transient):
  connection, credentials        →  transport, never counts
  everything else                →  soft,      never counts
severity 5 or absent:
  connection, credentials        →  transport, never counts
  mailbox                        →  hard,      counts
  domain, capacity, unknown      →  soft,      counts
  sender, message, deferral      →  soft,      never counts
```

Two lines here were wrong and were found by review rather than by reasoning:

- **`credentials` at 4xx** was `soft`, so it spent an attempt per recipient.
  Postfix answers `454 4.7.0 Temporary authentication failure` while its own
  SASL backend is down: five minutes of our own outage burned five of every
  recipient's six attempts on a fault that was not theirs.
- **`capacity` at 5xx** never counted, on the reasoning that a full mailbox can
  be emptied. True, and it meant a mailbox nobody had emptied in a month was
  retried through the entire seventeen-hour ladder on every broadcast, forever.
  It counts now, which ends it on the *lapsing* thirty-day suppression — the
  one that comes back and checks. At 4xx it still never counts.

`counts` is whether an exhausted attempt budget may suppress the address. It
matters more than the verdict itself, because anything a provider sends
identically to every recipient of a broadcast — our reputation, our password,
this message — takes a whole audience off the list at once if it counts.

It is **derived from the subject, not decided separately**. A standalone
predicate was added in one round and had drifted from the classifier by the
next: it excluded reputation blocks by *wording*, so Exchange Online's
`550 5.7.606 Access denied, banned sending IP` — which contains none of the
words it looked for — counted, and six attempts took every Outlook recipient in
a broadcast off the list together for thirty days. One source of truth cannot
drift from itself.

## Reading the reply

Codes and enhanced statuses are read **positionally**, not scanned for:

- A reply code is the first token of a reply line. The port in
  `127.0.0.1:587`, the duration in `try again in 500 seconds` and the octet in
  `10.5.3.2` are in none of those positions.
- An enhanced status is a whole token. `10.5.3.2` offers `5.3.2`, but it is
  preceded by a dot.
- The **most severe** code anywhere in the reply decides severity, because a
  bounce recounts its own history: a quoted `450` above a final `550` is a
  footnote.
- Only the code a reply **opens with** may be read as an authentication
  refusal. A bare `535` anywhere matched `original message size: 535 KB`.

Whether the reply **names a mailbox** is read the same way, because it is what
separates AOL's `This account has been disabled or discontinued` from a relay
refusing our own account with the same words. Role addresses are stripped
*before* that question is asked: providers cite a complaint address inside the
block itself (`postmaster@`, `abuse@`, `support@`), and counting those as a
named recipient turned every such policy block into a hard bounce.

One caveat worth knowing rather than fixing: **Postfix's own default for an
unroutable domain is `450`, not `550`**, and only becomes permanent when the
queue lifetime expires. So `domain` is reached far more often at transient
severity than the row suggests, where it never counts — the counting path is
for the relays that answer permanently on the first attempt.

## Which statuses decide, and which only lean

`SUBJECT_CODES` marks each status either `decide` (the status settles it) or
`refine` (wording is consulted first, and the status says what it means if no
wording matches).

`7.x` is the important `refine`: it is where every provider puts a reputation
block, a DKIM failure *and* — at Yandex — a genuinely dead mailbox
(`550 5.7.1 No such user!`). The status alone cannot separate those. It leans
reputational and lets wording say otherwise.

`5.4.1` is the other: Exchange Online puts its unknown-recipient reply there,
and its wording (`Recipient address rejected`) is Postfix's universal wrapper
for reputation blocks too. The status is the only thing that separates them.

### The class is part of the status

Rows are keyed `class.subject.detail`, and the lookup order is exact,
`*.subject.detail`, `class.subject.*`, `*.subject.*`. Dropping the class was
wrong three times:

- **3.x** at 4xx is the receiving server having a moment; at 5xx it is where
  AT&T puts its RBL refusal (`553 5.3.0 ... DNSBL:RBL ... _is_blocked`). Read
  as a connection fault — retried without limit, attempt refunded — a permanent
  reputation block was retried every sixty seconds for three days at the
  provider that had just blocklisted us.
- **2.1** has two documented Google meanings: an inactive account, and *"the
  user you are trying to contact is receiving email at a rate that prevents
  additional messages from being delivered"*. The second is a live customer
  with a busy inbox, and `decide: mailbox` suppressed them permanently on the
  first attempt.
- **4.6** is "routing loop detected" in the registry. Zoho sends it to the
  *sending* client: `550 5.4.6 Unusual sending activity detected`, a block on
  our own account that lifts within the hour. As a `decide: domain` row it
  counted, so one hour of throttling suppressed every recipient for a month.

A named detail has to outrank a class wildcard, not the other way round:
consulted after `5.3.*`, the row for `*.3.4` — `552 5.3.4 Message too big for
system`, the one 3.x reply that is about the message — was unreachable.

### The backstop: blast radius

Every rule above is a table row, and a table row only helps for a reply
somebody has already seen. A provider that starts refusing us tomorrow, in
words no row matches, produces `unknown` — which counts, by design, because six
unexplained failures is the one case where giving up on an address is honest.

Six unexplained failures for *the whole list* in the same hour is not a list of
dead mailboxes, and no single reply carries the information needed to tell the
difference. So that case is **counted rather than classified**: past
twenty-five `repeated_failure` suppressions for one tenant in one hour, further
ones are declined. Sends still fail and the retry ladder still gives up on each
message, which is the right outcome for an outage. Hard bounces and complaints
are untouched — those are facts about a mailbox, and a broadcast into a stale
list genuinely does produce thousands at once.

## Adding a provider

1. Add the reply to `test/support/bounce-corpus.ts` with the verdict you
   believe is right and **why**.
2. Run the suite. If it fails, add or amend a row in `bounce-table.ts` whose
   `source` quotes that provider's reply.
3. Do not reorder anything else. There is no precedence left to reorder.
