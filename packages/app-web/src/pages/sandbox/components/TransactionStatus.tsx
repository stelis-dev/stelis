import type { ReactNode } from 'react';

interface TransactionStatusProps {
  status: 'idle' | 'building' | 'executing' | 'success' | 'error';
}

const STATUS_LABELS: Record<TransactionStatusProps['status'], ReactNode> = {
  idle: null,
  building: '⏳ Building transaction...',
  executing: '📡 Submitting to network...',
  success: '✅ Transaction confirmed',
  error: '❌ Transaction failed',
};

export function TransactionStatus({ status }: TransactionStatusProps) {
  const label = STATUS_LABELS[status];
  if (!label) return null;
  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        fontSize: 13,
        background:
          status === 'success'
            ? 'rgba(76,175,80,0.12)'
            : status === 'error'
              ? 'rgba(244,67,54,0.12)'
              : 'rgba(255,255,255,0.06)',
        color:
          status === 'success'
            ? '#4caf50'
            : status === 'error'
              ? '#f44336'
              : 'var(--text-secondary, #aaa)',
      }}
    >
      {label}
    </div>
  );
}
