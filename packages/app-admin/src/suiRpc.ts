export type AppAdminNetwork = 'testnet' | 'mainnet';

const SUI_RPC_URL_BY_NETWORK: Record<AppAdminNetwork, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};

export function getSuiRpcUrl(network: AppAdminNetwork): string {
  return SUI_RPC_URL_BY_NETWORK[network];
}
