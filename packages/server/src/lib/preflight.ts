import { config } from '../config.js';
import { chainInfo } from './chains.js';

/**
 * Configuration checks that run at boot.
 *
 * These exist because the expensive mistakes here are all silent: a mainnet
 * deployment with no reward budget works perfectly right up until the first
 * person tries to bridge and finds the reserve empty.
 */

export interface PreflightFinding {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** L1 TBAY: fixed supply, 9 decimals, no mint function. Verified on-chain. */
export const L1_TOTAL_SUPPLY_TOKENS = 1_000_000n;

export function preflight(): PreflightFinding[] {
  const cfg = config();
  const findings: PreflightFinding[] = [];
  const chain = chainInfo(cfg.chain.chainId);
  const isMainnet = chain !== null && !chain.testnet;

  if (!chain) {
    findings.push({
      level: 'warning',
      code: 'unknown_chain',
      message: `TBAY_CHAIN_ID ${cfg.chain.chainId} is not a chain this build knows about.`,
    });
  }

  const cap = BigInt(cfg.chain.rewardSupplyCapWei);

  if (isMainnet && cap <= 0n) {
    findings.push({
      level: 'error',
      code: 'uncapped_on_mainnet',
      message:
        'TBAY_REWARD_SUPPLY_CAP_WEI is 0 (unlimited) on a mainnet chain. ' +
        'L1 TBAY is a fixed 1,000,000 supply with no mint function, while the L2 ' +
        'contract can mint up to 100,000,000 — so an uncapped reward programme can ' +
        'promise far more than the bridge can ever honour. Set the cap to the L1 ' +
        'reserve you actually hold. See docs/TOKEN.md.',
    });
  }

  // Even the full L1 supply cannot back more than 1,000,000 bridged tokens.
  const l1CapacityWei = L1_TOTAL_SUPPLY_TOKENS * 10n ** 18n;
  if (cap > l1CapacityWei) {
    findings.push({
      level: 'error',
      code: 'cap_exceeds_l1_supply',
      message:
        `TBAY_REWARD_SUPPLY_CAP_WEI allows ${cap / 10n ** 18n} TBAY, but only ` +
        `${L1_TOTAL_SUPPLY_TOKENS} L1 TBAY will ever exist. Anything above that ` +
        'cannot be bridged back to Ethereum, whatever reserve you hold.',
    });
  }

  if (isMainnet && cfg.chain.supplyMode === 'mint') {
    findings.push({
      level: 'warning',
      code: 'minting_on_mainnet',
      message:
        'Reward redemptions mint new L2 supply. Remember the L2 constructor also ' +
        'mints 1,000,000 TBAY to the deployer on deployment — subtract anything ' +
        'that could be bridged back from your reward budget.',
    });
  }

  if (cfg.rewards.refundExpiredClaims) {
    findings.push({
      level: 'error',
      code: 'unsafe_claim_refunds',
      message:
        'CLAIM_REFUND_ON_EXPIRY is on. The deployed TBAYL2.claim() takes no ' +
        'deadline, so a voucher stays valid on-chain forever — refunding it lets ' +
        'someone take the points back and still mint. Only enable this against a ' +
        'contract that enforces a deadline inside claim().',
    });
  }

  if (isMainnet && !cfg.chain.rpcUrl) {
    findings.push({
      level: 'error',
      code: 'no_rpc_on_mainnet',
      message:
        'No TBAY_RPC_URL. Without it, bridge burns cannot be verified and claims ' +
        'cannot be reconciled.',
    });
  }

  if (cfg.isProduction && cfg.email.transport === 'log') {
    findings.push({
      level: 'warning',
      code: 'email_to_log',
      message: 'EMAIL_TRANSPORT is "log" in production: message bodies go to the application log.',
    });
  }

  for (const [key, value] of [
    ['IDENTITY_SALT', cfg.security.identitySalt],
    ['TOKEN_SECRET', cfg.security.tokenSecret],
  ] as const) {
    if (cfg.isProduction && value.startsWith('dev-')) {
      findings.push({
        level: 'error',
        code: 'default_secret',
        message: `${key} is still the development default in production.`,
      });
    }
  }

  return findings;
}

export function formatPreflight(findings: PreflightFinding[]): string {
  return findings
    .map((finding) => `  [${finding.level.toUpperCase()}] ${finding.code}: ${finding.message}`)
    .join('\n');
}
