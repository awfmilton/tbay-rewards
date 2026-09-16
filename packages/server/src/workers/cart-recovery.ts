import { db } from '../db/pool.js';
import { unsubscribeRequestUrl } from '../services/newsletter.js';
import { config } from '../config.js';
import {
  advanceRecoveryStage,
  dueForRecovery,
  sweepAbandonedCarts,
  type RecoveryCandidate,
} from '../services/carts.js';
import { getTemplate, queueEmail, renderTemplate, senderFor } from '../services/email.js';
import { shouldTrack } from '../services/email-tracking.js';
import { fire } from '../services/automations.js';
import { getTenantById } from '../services/tenants.js';
import { getContact } from '../services/contacts.js';

export interface RecoveryRun {
  abandoned: number;
  queued: number;
}

/**
 * One pass of the abandoned-cart pipeline: mark quiet carts abandoned, then
 * queue whichever recovery email is due.
 *
 * The stage counter advances in the same pass that queues the email, and the
 * email itself carries a per-cart-per-stage dedupe key, so a crashed or
 * concurrent run cannot send stage 1 twice.
 */
export async function runCartRecovery(): Promise<RecoveryRun> {
  const abandonedCarts = await sweepAbandonedCarts();

  for (const cart of abandonedCarts) {
    if (!cart.contact_id) continue;
    const tenant = await getTenantById(cart.tenant_id);
    const contact = await getContact(cart.tenant_id, cart.contact_id);
    if (!tenant || !contact) continue;

    await fire(tenant.id, 'cart.abandoned', {
      contact,
      data: {
        cart_token: cart.cart_token,
        item_count: cart.item_count,
        subtotal_cents: cart.subtotal_cents,
        currency: cart.currency,
        recovery_url: `${config().publicUrl}/c/${cart.recovery_token}`,
      },
      dedupeKey: `cart_abandoned:${cart.id}`,
    });
  }

  const due = await dueForRecovery();
  let queued = 0;

  for (const cart of due) {
    const sent = await queueRecoveryEmail(cart);
    if (sent) queued += 1;
  }

  return { abandoned: abandonedCarts.length, queued };
}

async function queueRecoveryEmail(cart: RecoveryCandidate): Promise<boolean> {
  if (!cart.email) return false;
  // Recovery mail is transactional-adjacent but still marketing; respect consent.
  if (!cart.marketing_consent) return false;

  const tenant = await getTenantById(cart.tenant_id);
  if (!tenant) return false;

  const stage = cart.recovery_stage + 1;
  const template = await getTemplate(tenant.id, `cart_recovery_${stage}`);
  if (!template) return false;

  const base = config().publicUrl;
  const unsubscribeUrl = unsubscribeRequestUrl(tenant.id, cart.email);
  const rendered = renderTemplate(template, {
    tenant_name: tenant.name,
    name: cart.contact_name ?? '',
    item_count: cart.item_count,
    subtotal: formatMoney(cart.subtotal_cents, cart.currency),
    recovery_url: `${base}/c/${cart.recovery_token}`,
    unsubscribe_url: unsubscribeUrl,
  });

  const result = await queueEmail({
    tenantId: tenant.id,
    contactId: cart.contact_id,
    templateKey: `cart_recovery_${stage}`,
    to: cart.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    dedupeKey: `cart_recovery:${cart.id}:${stage}`,
    // Recovery mail is marketing: it gets tracked and it carries a one-click
    // unsubscribe header, because "stop reminding me about my cart" is exactly
    // the request the header exists to serve.
    track: shouldTrack(tenant),
    unsubscribeUrl,
    ...senderFor(tenant),
  });

  await advanceRecoveryStage(db(), cart.id, stage);
  return result.queued;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
