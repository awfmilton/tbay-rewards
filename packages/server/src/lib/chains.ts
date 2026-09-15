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
 * TBAY's decimal split across layers.
 *
 * L1 was minted with 9 decimals and a fixed supply; L2 uses the ERC-20 default
 * of 18. Every bridge amount therefore scales by 10^9, and an L2 balance that
 * is not a whole multiple of 10^9 carries dust that cannot cross.
 */
export const L1_DECIMALS = 9;
export const L2_DECIMALS = 18;
export const BRIDGE_SCALE = 10n ** BigInt(L2_DECIMALS - L1_DECIMALS);

/** Split an L2 amount into the part that can bridge and the dust that cannot. */
export function splitBridgeAmount(l2AmountWei: bigint): {
  l1Amount: bigint;
  burnable: bigint;
  dust: bigint;
} {
  const l1Amount = l2AmountWei / BRIDGE_SCALE;
  const burnable = l1Amount * BRIDGE_SCALE;
  return { l1Amount, burnable, dust: l2AmountWei - burnable };
}
