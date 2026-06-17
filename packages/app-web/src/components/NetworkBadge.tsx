import { useAppConfig } from '../AppConfigContext';

/**
 * NetworkBadge — displays testnet/mainnet from AppConfigContext.
 *
 * Uses the centralized /relay/config fetch via AppConfigProvider.
 * No independent fetch — eliminates duplicate /relay/config calls.
 */
export function NetworkBadge() {
  const { config } = useAppConfig();

  if (!config) return null;

  const network = config.network;
  const isMainnet = network === 'mainnet';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 99,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
        border: `1px solid ${isMainnet ? 'rgba(76,175,80,0.4)' : 'rgba(255,160,0,0.4)'}`,
        background: isMainnet ? 'rgba(76,175,80,0.1)' : 'rgba(255,160,0,0.1)',
        color: isMainnet ? '#81c784' : '#ffb74d',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isMainnet ? '#4caf50' : '#ffa726',
          display: 'inline-block',
        }}
      />
      {network}
    </span>
  );
}
