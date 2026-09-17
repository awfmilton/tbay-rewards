import { queryOne, type Queryable } from '../db/pool.js';
import type { Tenant } from './tenants.js';

/**
 * The marketing frequency cap — how much mail one contact may receive.
 *
 * Its own module because it was private to the broadcast sender, and a cap
 * that only one of a retailer's four senders honours is not a cap. A tenant
 * setting `maxMarketingPerDay: 1` got exactly that for campaigns and nothing
 * at all for automations, which is where mail actually stacks up: a welcome
 * series, an abandoned-cart sequence and a points-awarded email can all fire
 * for the same person on the same afternoon, each one certain it is the only
 * message being sent.
 *
 * Mautic applies its cap to every channel for this reason. So does this now.
 */

/** Marketing sends per contact allowed in a rolling window. */
export interface FrequencyRule {
  perDay: number | null;
  perWeek: number | null;
}

export function frequencyRuleFor(tenant: Tenant): FrequencyRule {
  const positive = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  };
  return {
    perDay: positive(tenant.settings?.maxMarketingPerDay),
    perWeek: positive(tenant.settings?.maxMarketingPerWeek),
  };
}

/**
 * Has this contact had enough marketing for now?
 *
 * Counts messages this contact was *sent*, not queued: a message stuck in the
 * queue has not reached anyone, and counting it would let a backlog silently
 * suppress a campaign.
 *
 * `unsubscribe_url IS NOT NULL` is what makes this count marketing only. A
 * transactional receipt carries no unsubscribe link -- there is nothing to
 * unsubscribe from -- so it never consumes anybody's allowance.
 */
export async function overFrequencyCap(
  runner: Queryable,
  tenantId: string,
  contactId: string,
  rule: FrequencyRule,
): Promise<string | null> {
  for (const [window, cap, label] of [
    ['1 day', rule.perDay, 'day'],
    ['7 days', rule.perWeek, 'week'],
  ] as const) {
    if (cap === null) continue;
    const row = await queryOne<{ n: string }>(
      runner,
      `SELECT COUNT(*) AS n FROM email_messages
        WHERE tenant_id = $1 AND contact_id = $2 AND status = 'sent'
          AND unsubscribe_url IS NOT NULL
          AND sent_at >= now() - $3::interval`,
      [tenantId, contactId, window],
    );
    if (Number(row?.n ?? 0) >= cap) return `frequency_cap_${label}`;
  }
  return null;
}
