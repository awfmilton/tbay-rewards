import { createTenant, type CreatedTenant, type TenantSettings } from './tenants.js';
import { installDefaultRules } from './rewards.js';
import { installDefaultAutomations } from './automations.js';
import { ensureList } from './newsletter.js';
import { installDefaultGamification } from './gamification.js';
import { installDefaultPointType } from './point-types.js';

export interface ProvisionInput {
  slug: string;
  name: string;
  currency?: string;
  timezone?: string;
  domains?: string[];
  settings?: TenantSettings;
}

/**
 * Stand up a retailer end to end: keys, default reward rules, starter
 * automations and a newsletter list. A tenant is usable the moment this returns.
 */
export async function provisionTenant(input: ProvisionInput): Promise<CreatedTenant> {
  const created = await createTenant(input);
  // First: the rules, badges and ranks below all resolve a currency, and
  // resolving one that does not exist yet would fall through to the implicit
  // default rather than the row the retailer will actually edit.
  await installDefaultPointType(created.tenant.id);
  await installDefaultRules(created.tenant.id);
  await installDefaultAutomations(created.tenant.id);
  await installDefaultGamification(created.tenant.id);
  await ensureList(created.tenant.id);
  return created;
}
