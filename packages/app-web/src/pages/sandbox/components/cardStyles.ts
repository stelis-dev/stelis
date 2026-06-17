import type { CSSProperties } from 'react';

export const SANDBOX_CARD_STYLE: CSSProperties = {
  background: 'var(--card-accent-bg, rgba(255,255,255,0.04))',
  border: '1px solid var(--card-accent, var(--border, #333))',
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
  // Ensure overflowing content is clipped inside the card boundary.
  overflow: 'hidden',
  transition: 'border-color 0.25s ease, background 0.25s ease',
};
