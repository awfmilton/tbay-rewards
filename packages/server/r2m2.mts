import { db, closeDb } from './src/db/pool.js';
import { upsertContact } from './src/services/contacts.js';
import { award, spend } from './src/services/points.js';
import { mergeContacts } from './src/services/merge.js';

const { rows: t } = await db().query<{ id: string }>("SELECT id FROM tenants WHERE slug='wptest'");
const tenantId = t[0]!.id;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let drift = 0;
let hits = 0;
// The window is: merge reads the loser's balance → spend commits → merge moves
// the ledger. Start the merge first, then slip the spend in a few ms later.
for (const delay of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50]) {
  const tag = `d${delay}`;
  const keep = await upsertContact(tenantId, { email: `r2mk${tag}@example.com` });
  const lose = await upsertContact(tenantId, { email: `r2ml${tag}@example.com` });
  await award(tenantId, { contactId: lose.id, points: 400, reason: 's', idempotencyKey: `r2ms${tag}` });

  const merge = mergeContacts(tenantId, { keepId: keep.id, mergeId: lose.id });
  await wait(delay);
  const sp = spend(tenantId, { contactId: lose.id, points: 100, reason: 'r', idempotencyKey: `r2mp${tag}` })
    .then(() => 'spent')
    .catch((e) => `refused: ${String(e.message).slice(0, 40)}`);

  const [m, s] = await Promise.allSettled([merge, sp]);
  const spendOutcome = s.status === 'fulfilled' ? s.value : 'threw';

  const { rows } = await db().query<{ balance: string; ledger: string }>(
    `SELECT b.balance,
            COALESCE((SELECT SUM(l.delta_points) FROM points_ledger l
                       WHERE l.tenant_id=b.tenant_id AND l.contact_id=b.contact_id
                         AND l.point_type=b.point_type), 0) AS ledger
       FROM points_balances b WHERE b.tenant_id=$1 AND b.contact_id=$2`,
    [tenantId, keep.id],
  );
  for (const row of rows) {
    hits += 1;
    if (Number(row.balance) !== Number(row.ledger)) {
      drift += 1;
      console.log(`delay ${delay}ms: balance ${row.balance} ledger ${row.ledger}  DRIFT  (${spendOutcome}, merge ${m.status})`);
    }
  }
}
console.log(drift === 0 ? `no drift across ${hits} checks` : `DRIFT in ${drift} of ${hits}`);
await closeDb();
