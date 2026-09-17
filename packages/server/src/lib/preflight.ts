import { config } from '../config.js';
import { chainInfo, maxBackedL2Wei } from './chains.js';

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

  const rate = BigInt(Math.max(1, Math.trunc(cfg.chain.bridgeL2PerL1)));

  // The deployed TBAYL2 scales by exactly 10^9, i.e. 1 L1 token per 1 L2 token.
  // Configuring a different rate here without changing the contract would have
  // the platform quote conversions the chain will not perform.
  if (rate !== 1n) {
    findings.push({
      level: 'warning',
      code: 'bridge_rate_not_one',
      message:
        `TBAY_BRIDGE_L2_PER_L1 is ${rate}, but the deployed TBAYL2 scales by ` +
        '10^9 exactly, which is a strict 1:1 token bridge. Only set this above 1 ' +
        'against an L2 contract whose bridgeMint/crosschainBurn apply the same ' +
        'rate, or withdrawals will release the wrong amount of L1.',
    });
  }

  // Whatever the rate, L2 supply has to stay inside what the L1 reserve backs.
  const reserve =
    cfg.chain.l1ReserveTokens > 0
      ? BigInt(Math.trunc(cfg.chain.l1ReserveTokens))
      : L1_TOTAL_SUPPLY_TOKENS;

  if (reserve > L1_TOTAL_SUPPLY_TOKENS) {
    findings.push({
      level: 'error',
      code: 'reserve_exceeds_l1_supply',
      message:
        `TBAY_L1_RESERVE_TOKENS is ${reserve}, but only ${L1_TOTAL_SUPPLY_TOKENS} ` +
        'L1 TBAY will ever exist and none can be minted.',
    });
  }

  const backedWei = maxBackedL2Wei(
    reserve > L1_TOTAL_SUPPLY_TOKENS ? L1_TOTAL_SUPPLY_TOKENS : reserve,
    rate,
  );

  if (cap > backedWei) {
    findings.push({
      level: 'error',
      code: 'cap_exceeds_backing',
      message:
        `TBAY_REWARD_SUPPLY_CAP_WEI allows ${cap / 10n ** 18n} L2 TBAY, but a ` +
        `reserve of ${reserve} L1 TBAY at ${rate}:1 backs only ` +
        `${backedWei / 10n ** 18n}. Anything above that cannot be bridged back ` +
        'to Ethereum, whatever else is true.',
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

  const secrets = [
    ['IDENTITY_SALT', cfg.security.identitySalt],
    ['TOKEN_SECRET', cfg.security.tokenSecret],
  ] as const;

  for (const [key, value] of secrets) {
    if (!cfg.isProduction) continue;

    if (value.startsWith('dev-')) {
      findings.push({
        level: 'error',
        code: 'default_secret',
        message: `${key} is still the development default in production.`,
      });
      continue;
    }

    // Short enough to brute-force is short enough to matter: `TOKEN_SECRET`
    // signs unsubscribe and preference links, and `IDENTITY_SALT` is what
    // stops a hashed email being reversed with a wordlist.
    if (value.length < 32) {
      findings.push({
        level: 'error',
        code: 'weak_secret',
        message:
          `${key} is ${value.length} characters. Use at least 32 random ones — ` +
          '`openssl rand -hex 32`.',
      });
    }
  }

  // One value doing two jobs means a weakness in either is a weakness in both,
  // and rotating one silently rotates the other.
  if (
    cfg.isProduction &&
    cfg.security.identitySalt !== '' &&
    cfg.security.identitySalt === cfg.security.tokenSecret
  ) {
    findings.push({
      level: 'error',
      code: 'shared_secret',
      message: 'IDENTITY_SALT and TOKEN_SECRET are the same value. Generate them separately.',
    });
  }

  // Attribution and preference cookies are set `Secure` in production, so a
  // plain-http public URL means the browser never sends them back and
  // attribution silently stops working.
  if (cfg.isProduction && cfg.publicUrl.startsWith('http://')) {
    findings.push({
      level: 'error',
      code: 'insecure_public_url',
      message:
        `PUBLIC_URL is ${cfg.publicUrl}. Cookies are set Secure in production, so ` +
        'over plain http the browser will never send them back: attribution, ' +
        'unsubscribe links and the preference centre all stop working.',
    });
  }

  return findings;
}

export function formatPreflight(findings: PreflightFinding[]): string {
  return findings
    .map((finding) => `  [${finding.level.toUpperCase()}] ${finding.code}: ${finding.message}`)
    .join('\n');
}
