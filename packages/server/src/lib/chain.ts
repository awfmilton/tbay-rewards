import { JsonRpcProvider, Contract, Wallet, verifyTypedData, getAddress, isAddress } from 'ethers';
import { config } from '../config.js';
import { ApiError } from './errors.js';

/**
 * EIP-712 plumbing for the deployed TBAYL2 contract.
 *
 * The domain and struct below must match TBAYL2 exactly. The contract builds its
 * digest with ERC20Permit's `_hashTypedDataV4`, which uses the ERC20Permit name
 * ("Thunder Bay Token") and version "1"; the struct comes from
 *   keccak256("Claim(address user,uint256 amount,uint256 nonce)")
 * A mismatch anywhere here produces a signature the contract rejects with
 * InvalidSigner, so treat these as part of the ABI.
 */
export const CLAIM_DOMAIN_NAME = 'Thunder Bay Token';
export const CLAIM_DOMAIN_VERSION = '1';

export const CLAIM_TYPES = {
  Claim: [
    { name: 'user', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface ClaimMessage {
  user: string;
  amount: bigint;
  nonce: bigint;
}

export function claimDomain(chainId: number, verifyingContract: string) {
  return {
    name: CLAIM_DOMAIN_NAME,
    version: CLAIM_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(verifyingContract),
  };
}

export interface ClaimSigner {
  readonly address: string;
  signClaim(message: ClaimMessage, chainId: number, contractAddress: string): Promise<string>;
}

class WalletClaimSigner implements ClaimSigner {
  constructor(private readonly wallet: Wallet) {}

  get address(): string {
    return this.wallet.address;
  }

  async signClaim(message: ClaimMessage, chainId: number, contractAddress: string): Promise<string> {
    return this.wallet.signTypedData(claimDomain(chainId, contractAddress), CLAIM_TYPES as never, {
      user: getAddress(message.user),
      amount: message.amount,
      nonce: message.nonce,
    });
  }
}

let signer: ClaimSigner | null = null;

/**
 * The wallet holding CLAIMER_ROLE on the L2 contract. It only ever signs — it
 * never sends transactions and needs no gas.
 */
export function claimSigner(): ClaimSigner {
  if (signer) return signer;
  const key = config().chain.claimSignerKey;
  if (!key) {
    throw new ApiError(
      503,
      'signer_unavailable',
      'No TBAY_CLAIM_SIGNER_KEY configured; token redemption is disabled',
    );
  }
  signer = new WalletClaimSigner(new Wallet(key));
  return signer;
}

/** Test/ops seam: install a signer without touching the environment. */
export function setClaimSigner(custom: ClaimSigner | null): void {
  signer = custom;
}

export function recoverClaimSigner(
  message: ClaimMessage,
  signature: string,
  chainId: number,
  contractAddress: string,
): string {
  return verifyTypedData(
    claimDomain(chainId, contractAddress),
    CLAIM_TYPES as never,
    { user: getAddress(message.user), amount: message.amount, nonce: message.nonce },
    signature,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Treasury transfers (supplyMode = 'treasury')
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends TBAY from a pre-funded treasury wallet.
 *
 * Only used when the platform is configured not to mint. Unlike the claim path,
 * this *does* require a hot wallet holding real tokens and gas — which is the
 * trade for a non-inflationary reward supply that an L1 reserve can back. The
 * key is read once at startup and never leaves this module.
 */
export interface TreasurySender {
  readonly address: string;
  transfer(to: string, amountWei: bigint): Promise<{ txHash: string }>;
  balance(): Promise<bigint>;
}

const TBAY_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

class WalletTreasurySender implements TreasurySender {
  private readonly wallet: Wallet;
  private readonly contract: Contract;

  constructor(key: string, rpcUrl: string, contractAddress: string) {
    this.wallet = new Wallet(key, new JsonRpcProvider(rpcUrl));
    this.contract = new Contract(contractAddress, TBAY_TRANSFER_ABI, this.wallet);
  }

  get address(): string {
    return this.wallet.address;
  }

  async transfer(to: string, amountWei: bigint): Promise<{ txHash: string }> {
    // Refuse rather than send a transaction we know will revert on-chain.
    const available = await this.balance();
    if (available < amountWei) {
      throw new ApiError(
        503,
        'treasury_exhausted',
        'The reward treasury does not hold enough TBAY to cover this redemption',
      );
    }
    const tx = await this.contract.transfer!(getAddress(to), amountWei);
    return { txHash: tx.hash as string };
  }

  async balance(): Promise<bigint> {
    return (await this.contract.balanceOf!(this.wallet.address)) as bigint;
  }
}

let treasury: TreasurySender | null = null;

export function treasurySender(): TreasurySender {
  if (treasury) return treasury;
  const cfg = config();
  if (!cfg.chain.treasuryKey || !cfg.chain.rpcUrl) {
    throw new ApiError(
      503,
      'treasury_unavailable',
      'Treasury supply mode needs TBAY_TREASURY_KEY and TBAY_RPC_URL',
    );
  }
  treasury = new WalletTreasurySender(cfg.chain.treasuryKey, cfg.chain.rpcUrl, cfg.chain.l2Contract);
  return treasury;
}

export function setTreasurySender(custom: TreasurySender | null): void {
  treasury = custom;
}

export function assertAddress(value: string, field = 'address'): string {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw ApiError.badRequest(`${field} is not a valid EVM address`);
  }
  return getAddress(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only chain access
// ─────────────────────────────────────────────────────────────────────────────

/** Just the fragments the platform reads; the full ABI lives in tbay-token-L2. */
export const TBAY_L2_READ_ABI = [
  'function isNonceUsed(uint256 nonce) view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function paused() view returns (bool)',
  'function getContractInfo() view returns (tuple(string name, string symbol, uint8 decimals, uint256 totalSupply, uint256 maxSupply, address l1Token, uint256 l1Chain, uint256 currentMinted, uint256 remainingCapacity))',
  'event RewardClaimed(address indexed user, uint256 amount, uint256 nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export interface TokenTransfer {
  from: string;
  to: string;
  value: bigint;
  blockNumber: number;
  confirmations: number;
}

/**
 * Chain reads the platform needs. Abstracted so redemption and spend
 * verification can be exercised without an RPC endpoint.
 */
export interface ChainClient {
  isNonceUsed(nonce: bigint): Promise<boolean>;
  isPaused(): Promise<boolean>;
  balanceOf(address: string): Promise<bigint>;
  /** Transfers of the TBAY token carried by one transaction. */
  transfersInTx(txHash: string): Promise<TokenTransfer[]>;
}

class RpcChainClient implements ChainClient {
  private readonly contract: Contract;
  private readonly provider: JsonRpcProvider;

  constructor(rpcUrl: string, contractAddress: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.contract = new Contract(contractAddress, TBAY_L2_READ_ABI, this.provider);
  }

  async isNonceUsed(nonce: bigint): Promise<boolean> {
    return (await this.contract.isNonceUsed!(nonce)) as boolean;
  }

  async isPaused(): Promise<boolean> {
    return (await this.contract.paused!()) as boolean;
  }

  async balanceOf(address: string): Promise<bigint> {
    return (await this.contract.balanceOf!(getAddress(address))) as bigint;
  }

  async transfersInTx(txHash: string): Promise<TokenTransfer[]> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return [];

    const head = await this.provider.getBlockNumber();
    const confirmations = Math.max(0, head - receipt.blockNumber + 1);
    const contractAddress = (await this.contract.getAddress()).toLowerCase();

    const transfers: TokenTransfer[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress) continue;
      const parsed = this.contract.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!parsed || parsed.name !== 'Transfer') continue;
      transfers.push({
        from: getAddress(parsed.args[0] as string),
        to: getAddress(parsed.args[1] as string),
        value: parsed.args[2] as bigint,
        blockNumber: receipt.blockNumber,
        confirmations,
      });
    }
    return transfers;
  }
}

let chainClient: ChainClient | null = null;

export function chain(): ChainClient | null {
  if (chainClient) return chainClient;
  const cfg = config();
  if (!cfg.chain.rpcUrl) return null;
  chainClient = new RpcChainClient(cfg.chain.rpcUrl, cfg.chain.l2Contract);
  return chainClient;
}

export function setChainClient(custom: ChainClient | null): void {
  chainClient = custom;
}

/**
 * Whole TBAY (18 decimals) → wei, without floating point.
 *
 * `String(n)` renders very small and very large numbers in exponent form
 * (`1e-7`, `5e+21`), which BigInt cannot parse — so this normalises to plain
 * decimal notation first rather than throwing on a perfectly valid amount.
 */
export function tokensToWei(tokens: number): bigint {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw ApiError.badRequest('amount must be a positive number');
  }
  // No ceiling here.
  //
  // There was one, at MAX_SAFE_INTEGER, and it was wrong twice over: it
  // refused 1e16 and 2^53, which a double holds exactly, and it sat *above*
  // the point where String() starts using exponents -- so it caught every
  // input the expansion below exists to handle and made that code
  // unreachable, including the 1.5e21 case it was written for.
  //
  // toPlainDecimal renders whatever String() gives -- the shortest decimal
  // that round-trips, not the exact binary value -- and converts that without
  // loss. So 0.1 becomes 1e17 wei rather than 100000000000000005, which is
  // what somebody asking for a tenth of a token means. How much is too much is
  // a question about money, and quoteCredit is where it is asked.

  const plain = toPlainDecimal(tokens);
  const [whole, fraction = ''] = plain.split('.');
  const padded = (fraction + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole || '0') * 10n ** 18n + BigInt(padded || '0');
}

function toPlainDecimal(value: number): string {
  const rendered = String(value);
  if (!rendered.includes('e') && !rendered.includes('E')) return rendered;

  // Expanded by hand, in both directions.
  //
  // `toFixed(20)` was doing this, and it does not: the spec says toFixed
  // returns String(x) unchanged once |x| >= 1e21, so the exponent survived and
  // the replace chain then chewed on it. `1.5e21` came out as
  // "5e+210000000000000" -- not an error, a different number, saved from being
  // minted only because BigInt happened to reject the letter e.
  const [mantissa, exponentText] = rendered.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const negative = mantissa!.startsWith('-');
  const [whole, fraction = ''] = mantissa!.replace(/^[+-]/, '').split('.');

  let plain: string;
  if (exponent >= 0) {
    const shift = exponent - fraction.length;
    plain =
      shift >= 0
        ? whole! + fraction + '0'.repeat(shift)
        : `${whole!}${fraction.slice(0, exponent)}.${fraction.slice(exponent)}`;
  } else {
    const zeros = -exponent - whole!.length;
    plain =
      zeros >= 0
        ? `0.${'0'.repeat(zeros)}${whole!}${fraction}`
        : `${whole!.slice(0, exponent)}.${whole!.slice(exponent)}${fraction}`;
  }

  return negative ? `-${plain}` : plain;
}

export function weiToTokenString(wei: bigint, decimals = 6): string {
  const whole = wei / 10n ** 18n;
  const remainder = wei % 10n ** 18n;
  if (decimals <= 0) return whole.toString();
  const fraction = remainder.toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
