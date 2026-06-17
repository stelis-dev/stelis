/**
 * Shared utility functions for app-admin pages.
 *
 * Extracted from DashboardPage and ConfigPage to eliminate duplication.
 */
import { useState } from 'react';

// ── Formatting ─────────────────────────────────────────────────────────────

/** Convert MIST (string | number | bigint) to SUI with 4 decimal places. */
export function mistToSui(mist: string | number | bigint): string {
  let bi: bigint;
  try {
    if (typeof mist === 'number') {
      if (!Number.isSafeInteger(mist)) return '—';
      bi = BigInt(mist);
    } else if (typeof mist === 'string') {
      if (!/^-?(?:0|[1-9]\d*)$/.test(mist)) return '—';
      bi = BigInt(mist);
    } else {
      bi = mist;
    }
  } catch {
    return '—';
  }
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  const whole = abs / 1_000_000_000n;
  const frac = abs % 1_000_000_000n;
  const fracStr = frac.toString().padStart(9, '0').slice(0, 4);
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

const SUI_AMOUNT_RE = /^\d+(?:\.\d+)?$/;

/** Convert a SUI amount string (e.g. "1.5") to MIST string. Rejects >9 decimal places. */
export function suiToMist(sui: string): string {
  const trimmed = sui.trim();
  if (!SUI_AMOUNT_RE.test(trimmed)) {
    throw new Error('SUI amount must be a non-negative decimal string');
  }
  const [wholePart, fracPart = ''] = trimmed.split('.');
  if (fracPart.length > 9) throw new Error('SUI amount cannot have more than 9 decimal places');
  const paddedFrac = fracPart.padEnd(9, '0');
  return (BigInt(wholePart || '0') * 1_000_000_000n + BigInt(paddedFrac)).toString();
}

/** Truncate a Sui address or object ID for display. */
export function truncateAddress(addr: string | null): string {
  if (!addr) return '—';
  if (addr.length <= 20) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

/** Truncate a shorter ID (package/config IDs). */
export function truncateId(id: string | null): string {
  if (!id) return '—';
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

// ── Components ─────────────────────────────────────────────────────────────

/** Inline copy-to-clipboard button. */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="Copy"
      className="copy-btn"
    >
      {copied ? (
        <span style={{ color: '#22c55e', fontSize: 12 }}>✓</span>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 115.77 122.88"
          fill="#94a3b8"
        >
          <path d="M89.62,13.96v7.73h12.19h0.01v0.02c3.85,0.01,7.34,1.57,9.86,4.1c2.5,2.51,4.06,5.98,4.07,9.82h0.02v0.02 v73.27v0.01h-0.02c-0.01,3.84-1.57,7.33-4.1,9.86c-2.51,2.5-5.98,4.06-9.82,4.07v0.02h-0.02h-61.7H40.1v-0.02 c-3.84-0.01-7.34-1.57-9.86-4.1c-2.5-2.51-4.06-5.98-4.07-9.82h-0.02v-0.02V92.51H13.96h-0.01v-0.02c-3.84-0.01-7.34-1.57-9.86-4.1 c-2.5-2.51-4.06-5.98-4.07-9.82H0v-0.02V13.96v-0.01h0.02c0.01-3.85,1.58-7.34,4.1-9.86c2.51-2.5,5.98-4.06,9.82-4.07V0h0.02h61.7 h0.01v0.02c3.85,0.01,7.34,1.57,9.86,4.1c2.5,2.51,4.06,5.98,4.07,9.82h0.02V13.96L89.62,13.96z M79.04,21.69v-7.73v-0.02h0.02 c0-0.91-0.39-1.75-1.01-2.37c-0.61-0.61-1.46-1-2.37-1v0.02h-0.01h-61.7h-0.02v-0.02c-0.91,0-1.75,0.39-2.37,1.01 c-0.61,0.61-1,1.46-1,2.37h0.02v0.01v64.59v0.02h-0.02c0,0.91,0.39,1.75,1.01,2.37c0.61,0.61,1.46,1,2.37,1v-0.02h0.01h12.19V35.65 v-0.01h0.02c0.01-3.85,1.58-7.34,4.1-9.86c2.51-2.5,5.98-4.06,9.82-4.07v-0.02h0.02H79.04L79.04,21.69z M105.18,108.92V35.65v-0.02 h0.02c0-0.91-0.39-1.75-1.01-2.37c-0.61-0.61-1.46-1-2.37-1v0.02h-0.01h-61.7h-0.02v-0.02c-0.91,0-1.75,0.39-2.37,1.01 c-0.61,0.61-1,1.46-1,2.37h0.02v0.01v73.27v0.02h-0.02c0,0.91,0.39,1.75,1.01,2.37c0.61,0.61,1.46,1,2.37,1v-0.02h0.01h61.7h0.02 v0.02c0.91,0,1.75-0.39,2.37-1.01c0.61-0.61,1-1.46,1-2.37h-0.02V108.92L105.18,108.92z" />
        </svg>
      )}
    </button>
  );
}
