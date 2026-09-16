/**
 * Chain registry.
 *
 * Everything a wallet needs to add or switch to the right network, plus the
 * explorer links the UI shows after a transaction. Keeping this in one place
 * means the browser, the plugin and the docs cannot drift apart about which
 * chain id TBAY lives on.
 */

export interface ChainInfo {
  chainId: number;
  /** 0x-prefixed hex, the form `wallet_switchEthereumChain` expects. */
  chainIdHex: string;
  name: string;
  shortName: string;
  rpcUrls: string[];
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
  /** thirdweb's slug for this chain, for its SDK and dashboards. */
  thirdwebSlug: string;
}

export const CHAINS: Record<number, ChainInfo> = {
  300: {
    chainId: 300,
    chainIdHex: '0x12c',
    name: 'zkSync Sepolia Testnet',
    shortName: 'zkSync Sepolia',
    rpcUrls: ['https://sepolia.era.zksync.dev'],
    explorerUrl: 'https://sepolia.explorer.zksync.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    testnet: true,
    thirdwebSlug: 'zksync-sepolia-testnet',
  },
  324: {
    chainId: 324,
    chainIdHex: '0x144',
    name: 'zkSync Era Mainnet',
    shortName: 'zkSync Era',
    rpcUrls: ['https://mainnet.era.zksync.io'],
    explorerUrl: 'https://explorer.zksync.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    testnet: false,
    thirdwebSlug: 'zksync-era',
  },
  1: {
    chainId: 1,
    chainIdHex: '0x1',
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    rpcUrls: ['https://eth.llamarpc.com'],
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    testnet: false,
    thirdwebSlug: 'ethereum',
  },
  11155111: {
    chainId: 11155111,
    chainIdHex: '0xaa36a7',
    name: 'Sepolia',
    shortName: 'Sepolia',
    rpcUrls: ['https://rpc.sepolia.org'],
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    testnet: true,
    thirdwebSlug: 'sepolia',
  },
};

export function chainInfo(chainId: number): ChainInfo | null {
  return CHAINS[chainId] ?? null;
}

/** Parameters for `wallet_addEthereumChain`, so a wallet can add zkSync itself. */
export function addChainParams(chainId: number): Record<string, unknown> | null {
  const chain = chainInfo(chainId);
  if (!chain) return null;
  return {
    chainId: chain.chainIdHex,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls,
    blockExplorerUrls: [chain.explorerUrl],
  };
}

export function txUrl(chainId: number, txHash: string): string | null {
  const chain = chainInfo(chainId);
  return chain ? `${chain.explorerUrl}/tx/${txHash}` : null;
}

export function addressUrl(chainId: number, address: string): string | null {
  const chain = chainInfo(chainId);
  return chain ? `${chain.explorerUrl}/address/${address}` : null;
}

/**
 * TBAY across the two layers.
 *
 * L1 was minted with 9 decimals and a fixed 1,000,000 supply; L2 uses the ERC-20
 * default of 18. Those are *decimals*, not an exchange rate — reconciling them
 * alone is a factor of 10^9 and gives a strict 1:1 token bridge, which is what
 * the currently deployed TBAYL2 implements.
 *
 * A two-tier design (a large L2 working supply backed by the scarce L1 asset)
 * adds a rate on top: `L2_PER_L1` whole L2 tokens per whole L1 token. The
 * platform reads it from config so it can follow the contract rather than
 * assuming, but note the deployed contract hardcodes 1:1 — raising this without
 * a matching contract change would have the platform promise conversions the
 * chain will not perform.
 */
export const L1_DECIMALS = 9;
export const L2_DECIMALS = 18;

/** L1 TBAY is fixed at 1,000,000 tokens and cannot be minted. Verified on-chain. */
export const L1_TOTAL_SUPPLY_TOKENS = 1_000_000n;

/**
 * Wei per L1 base unit, for a given rate.
 *
 *   1 whole L1 token  = 10^9 L1 base units
 *                     = rate whole L2 tokens
 *                     = rate * 10^18 wei
 *   → 1 L1 base unit  = rate * 10^9 wei
 */
export function bridgeScale(l2PerL1: bigint): bigint {
  if (l2PerL1 <= 0n) throw new Error('The bridge rate must be at least 1');
  return l2PerL1 * 10n ** BigInt(L2_DECIMALS - L1_DECIMALS);
}

/** The 1:1 scale the deployed contract uses. */
export const BRIDGE_SCALE = bridgeScale(1n);

export interface BridgeSplit {
  /** In L1 base units — what the L1 release should pay out. */
  l1Amount: bigint;
  /** In wei — the part of the L2 amount that actually crosses. */
  burnable: bigint;
  /** In wei — below one L1 base unit, so it cannot cross. */
  dust: bigint;
}

/**
 * Split an L2 amount into the part that can bridge and the remainder that
 * cannot, at the given rate.
 */
export function splitBridgeAmount(l2AmountWei: bigint, l2PerL1: bigint = 1n): BridgeSplit {
  const scale = bridgeScale(l2PerL1);
  const l1Amount = l2AmountWei / scale;
  const burnable = l1Amount * scale;
  return { l1Amount, burnable, dust: l2AmountWei - burnable };
}

/**
 * The most L2 supply a given L1 reserve can ever back.
 *
 * This is the ceiling the reward budget has to sit under: mint more L2 than
 * this and the last holders to bridge find the reserve empty.
 */
export function maxBackedL2Wei(l1ReserveTokens: bigint, l2PerL1: bigint = 1n): bigint {
  return l1ReserveTokens * l2PerL1 * 10n ** BigInt(L2_DECIMALS);
}
