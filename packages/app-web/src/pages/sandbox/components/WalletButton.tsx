import { useEffect, useState } from 'react';
import { ConnectModal, useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';

/**
 * Clean WalletButton using official dapp-kit-react APIs:
 *  - ConnectModal with open prop  → connect flow
 *  - dAppKit.disconnectWallet()  → disconnect
 * No hidden elements, no overlays.
 */
export function WalletButton() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const [modalOpen, setModalOpen] = useState(false);
  const isConnected = !!account;

  // Close modal automatically when wallet connects
  useEffect(() => {
    if (isConnected) setModalOpen(false);
  }, [isConnected]);

  const handleClick = () => {
    if (isConnected) {
      dAppKit.disconnectWallet();
    } else {
      setModalOpen(true);
    }
  };

  const label = isConnected
    ? `${account.address.slice(0, 6)}…${account.address.slice(-4)}`
    : 'Connect Wallet';

  return (
    <>
      {/* Wallet selection modal */}
      <ConnectModal
        open={modalOpen}
        // Web Component fires 'close' event; use ref-based handler via effect
        ref={(el: unknown) => {
          const node = el as EventTarget | null;
          if (!node) return;
          node.addEventListener('close', () => setModalOpen(false), { once: false });
        }}
      />

      {/* Styled button */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleClick()}
        title={isConnected ? 'Disconnect wallet' : 'Connect wallet'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 16px',
          borderRadius: 8,
          border: isConnected ? '1px solid rgba(99,102,241,0.4)' : 'none',
          background: isConnected
            ? 'rgba(99,102,241,0.12)'
            : 'linear-gradient(135deg, #6366f1, #818cf8)',
          color: isConnected ? '#818cf8' : '#fff',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          transition: 'opacity 0.15s, transform 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.opacity = '0.85';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.opacity = '1';
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: isConnected ? '#4caf50' : 'rgba(255,255,255,0.6)',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        {label}
        {isConnected && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>✕</span>}
      </div>
    </>
  );
}
