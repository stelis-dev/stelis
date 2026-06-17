/**
 * WalletProvider — wraps @mysten/dapp-kit-react for the app.
 *
 * Network is resolved from AppConfigContext (API fetch).
 * createDAppKit() is called lazily after network is available.
 */
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { type ReactNode, useMemo } from 'react';
import { useAppConfig, type AppWebNetwork } from '../../../AppConfigContext';
import { APP_WEB_SUI_RPC_URL } from '../../../runtimeEnv';

function buildDAppKit(network: AppWebNetwork) {
  return createDAppKit({
    networks: [network] as const,
    createClient: (n) =>
      new SuiGrpcClient({
        network: n,
        baseUrl: APP_WEB_SUI_RPC_URL,
      }),
  });
}

// Register types for hook type inference
declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: ReturnType<typeof buildDAppKit>;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { config } = useAppConfig();

  // config is guaranteed non-null here because App.tsx gates rendering.
  const dAppKit = useMemo(() => buildDAppKit(config!.network), [config]);

  return <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>;
}
