import 'dotenv/config';

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} must be a number`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const env = str('NODE_ENV', 'development');
  return {
    env,
    isProduction: env === 'production',
    host: str('HOST', '0.0.0.0'),
    port: num('PORT', 4000),
    /** Public origin of this API, used to build tracking, opt-in and share links. */
    publicUrl: str('PUBLIC_URL', 'http://localhost:4000').replace(/\/+$/, ''),
    logLevel: str('LOG_LEVEL', env === 'test' ? 'silent' : 'info'),

    database: {
      url: str('DATABASE_URL', 'postgres://localhost:5432/tbay_rewards'),
      poolSize: num('DATABASE_POOL_SIZE', 10),
      ssl: bool('DATABASE_SSL', false),
    },

    security: {
      /** Salt for the platform-wide member email hash that links a person across retailers. */
      identitySalt: str('IDENTITY_SALT', 'dev-identity-salt-change-me'),
      /** Signs attribution cookies and opt-in tokens. */
      tokenSecret: str('TOKEN_SECRET', 'dev-token-secret-change-me'),
      /** Requests per minute per tenant on the ingest endpoints. */
      ingestRatePerMinute: num('INGEST_RATE_PER_MINUTE', 600),
      adminRatePerMinute: num('ADMIN_RATE_PER_MINUTE', 300),
    },

    tracking: {
      /** A session ends after this many minutes without an event. */
      sessionTimeoutMinutes: num('SESSION_TIMEOUT_MINUTES', 30),
      /** Pointer samples per page view kept after server-side downsampling. */
      maxHeatmapPointsPerBatch: num('MAX_HEATMAP_POINTS_PER_BATCH', 500),
      maxEventsPerBatch: num('MAX_EVENTS_PER_BATCH', 100),
    },

    carts: {
      /** Inactivity before an active cart is considered abandoned. */
      abandonAfterMinutes: num('CART_ABANDON_AFTER_MINUTES', 60),
      /** Hours after abandonment for each recovery email stage. */
      recoveryStageHours: str('CART_RECOVERY_STAGE_HOURS', '1,24,72')
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value)),
    },

    commissions: {
      /** Attribution window for a writer link click to earn on a later order. */
      attributionWindowDays: num('COMMISSION_ATTRIBUTION_WINDOW_DAYS', 30),
      /** Refund-protection hold before a commission can be paid out. */
      holdDays: num('COMMISSION_HOLD_DAYS', 30),
      defaultRateBps: num('COMMISSION_DEFAULT_RATE_BPS', 500),
    },

    rewards: {
      /** Points burned per 1 whole TBAY minted. */
      pointsPerToken: num('POINTS_PER_TOKEN', 100),
      /** Minimum points a member must burn in one redemption. */
      minRedeemPoints: num('MIN_REDEEM_POINTS', 100),
      /** A signed claim voucher is valid for this long. */
      claimTtlMinutes: num('CLAIM_TTL_MINUTES', 60),
      /**
       * Network-wide floor: cents of store credit per 1 whole TBAY spent at any
       * retailer. A retailer may offer a bonus on top (settings.creditBonusBps)
       * but can never honour TBAY below this, so the token is worth at least the
       * same everywhere on the network.
       */
      creditCentsPerToken: num('CREDIT_CENTS_PER_TOKEN', 100),
      spendTtlMinutes: num('SPEND_TTL_MINUTES', 60),
    },

    chain: {
      /** zkSync Sepolia (300) pre-launch; zkSync Era mainnet is 324. */
      chainId: num('TBAY_CHAIN_ID', 300),
      l2Contract: str('TBAY_L2_CONTRACT', '0x74eb73ACa939Fc911f79D9589e808f0207684D09'),
      l1Contract: str('TBAY_L1_CONTRACT', '0xC17e078E914aB6023dd48831358067d428409116'),
      rpcUrl: process.env.TBAY_RPC_URL ?? '',
      /** Private key holding CLAIMER_ROLE on the L2 contract. Absent in test/dev. */
      claimSignerKey: process.env.TBAY_CLAIM_SIGNER_KEY ?? '',
      /** Contract bounds mirrored from TBAYL2 so vouchers are always claimable. */
      minClaimWei: str('TBAY_MIN_CLAIM_WEI', '1000000000000000'),
      maxClaimWei: str('TBAY_MAX_CLAIM_WEI', '10000000000000000000000'),
      maxMintPerWindowWei: str('TBAY_MAX_MINT_PER_WINDOW_WEI', '100000000000000000000000'),
      /**
       * Lifetime ceiling on reward tokens this platform will ever issue, in wei.
       * '0' means unlimited.
       *
       * This is the bridge-solvency guard: L1 TBAY is fixed at 1,000,000 tokens
       * and already fully minted, so any reward token that might later be
       * bridged L2→L1 has to be covered by an L1 reserve you actually hold. Set
       * this to the size of that reserve and the platform physically cannot
       * promise more than you can honour.
       */
      rewardSupplyCapWei: str('TBAY_REWARD_SUPPLY_CAP_WEI', '0'),
      /**
       * How reward tokens are sourced.
       *   'mint'     — the customer's wallet calls TBAYL2.claim() and mints.
       *   'treasury' — the platform transfers from a pre-funded treasury wallet.
       * Mint is the launch default; treasury is the non-inflationary path for
       * Era mainnet, where every reward token must be backed by an L1 reserve.
       */
      supplyMode: str('TBAY_SUPPLY_MODE', 'mint') as 'mint' | 'treasury',
      /** Treasury wallet holding the pre-funded reward allocation. */
      treasuryAddress: process.env.TBAY_TREASURY_ADDRESS ?? '',
      /** Key that sends treasury transfers. Only needed when supplyMode=treasury. */
      treasuryKey: process.env.TBAY_TREASURY_KEY ?? '',
      rateLimitWindowSeconds: num('TBAY_RATE_LIMIT_WINDOW_SECONDS', 3600),
    },

    email: {
      transport: str('EMAIL_TRANSPORT', 'log') as 'log' | 'smtp' | 'memory',
      fromName: str('EMAIL_FROM_NAME', 'TBAY Rewards'),
      fromAddress: str('EMAIL_FROM_ADDRESS', 'no-reply@tbay.tk'),
      smtpUrl: process.env.SMTP_URL ?? '',
    },
  };
}

let cached: Config | null = null;

export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: forget the memoised config so env changes take effect. */
export function resetConfig(): void {
  cached = null;
}
