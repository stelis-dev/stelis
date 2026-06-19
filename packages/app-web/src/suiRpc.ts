import type { AppWebNetwork } from './AppConfigContext';

const SUI_RPC_URL_BY_NETWORK: Record<AppWebNetwork, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};

export function getSuiRpcUrl(network: AppWebNetwork): string {
  return SUI_RPC_URL_BY_NETWORK[network];
}
