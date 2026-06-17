import { useState, useCallback } from 'react';
import { canonicalizeTarget } from '@stelis/sdk';

/**
 * AllowedTargetsBuilder — R-10 target hash tool.
 *
 * Uses canonicalizeTarget from @stelis/sdk (browser-safe public entry).
 * The server-side canonicalization implementation lives in core-relay; this
 * browser entry follows the same normalization rule for R-10 hashing.
 * Browser Web Crypto API for sha256 — no Node dependency.
 *
 * Provides "auto-fill" preset for the test TX's required MoveCall target:
 *   1. 0x2::coin::zero (minimal MoveCall used by StudioExecutionPanel)
 *
 * For real dApp promotions, operators add their own MoveCall targets manually.
 * R-10 validates ALL MoveCall targets in the PTB — all must be allowlisted.
 */

interface TargetEntry {
  packageId: string;
  module: string;
  fn: string;
  canonical: string;
  hash: string;
}

// No props needed — self-contained hash tool.

async function computeHash(canonical: string): Promise<string> {
  const encoded = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function AllowedTargetsBuilder() {
  const [packageId, setPackageId] = useState('');
  const [module, setModule] = useState('');
  const [fn, setFn] = useState('');
  const [entries, setEntries] = useState<TargetEntry[]>([]);
  const [computing, setComputing] = useState(false);

  const addEntry = useCallback(async (pkg: string, mod: string, func: string) => {
    const canonical = canonicalizeTarget(pkg, mod, func);
    const hash = await computeHash(canonical);
    setEntries((prev) => {
      if (prev.some((e) => e.hash === hash)) return prev;
      return [...prev, { packageId: pkg, module: mod, fn: func, canonical, hash }];
    });
    return { canonical, hash };
  }, []);

  const addTarget = useCallback(async () => {
    if (!packageId.trim() || !module.trim() || !fn.trim()) return;
    setComputing(true);
    try {
      await addEntry(packageId.trim(), module.trim(), fn.trim());
      setPackageId('');
      setModule('');
      setFn('');
    } finally {
      setComputing(false);
    }
  }, [packageId, module, fn, addEntry]);

  /**
   * Auto-fill: adds the MoveCall targets required by the test TX.
   *
   * StudioExecutionPanel builds a 2-step MoveCall PTB:
   *   1. 0x2::coin::zero<SUI> — creates a zero-balance Coin
   *   2. 0x2::coin::destroy_zero<SUI> — consumes it (Coin has no `drop`)
   *
   * R-10 enforcement validates ALL MoveCall targets in the PTB.
   * This auto-fill adds both matching targets for quick testing.
   *
   * For real dApp promotions, operators should add their own targets manually.
   */
  const autoFillTestTargets = useCallback(async () => {
    setComputing(true);
    try {
      // Target 1: 0x2::coin::zero (creates zero-balance Coin)
      await addEntry('0x2', 'coin', 'zero');
      // Target 2: 0x2::coin::destroy_zero (consumes zero-balance Coin)
      await addEntry('0x2', 'coin', 'destroy_zero');
    } finally {
      setComputing(false);
    }
  }, [addEntry]);

  const removeEntry_cb = useCallback((hash: string) => {
    setEntries((prev) => prev.filter((e) => e.hash !== hash));
  }, []);

  const clearAll = useCallback(() => {
    setEntries([]);
  }, []);

  const allHashes = entries.map((e) => e.hash).join(',');

  return (
    <div className="promo-panel">
      <h3 className="promo-panel-title">🎯 Allowed Targets Builder</h3>
      <p className="promo-panel-desc">
        Build <code>allowedTargets</code> hashes for promotion configuration. Uses{' '}
        <code>canonicalizeTarget</code> from <code>@stelis/sdk</code>, the browser-safe public entry
        that matches the server-side R-10 canonicalization rule.
      </p>

      {/* Auto-fill preset */}
      <div style={{ marginBottom: 12 }}>
        <button
          onClick={autoFillTestTargets}
          disabled={computing}
          className="promo-btn promo-btn-secondary"
        >
          {computing ? '⏳ Computing...' : '⚡ Auto-fill Test Targets'}
        </button>
        <p className="promo-hint">
          Adds both MoveCall targets used by the test TX: <code>0x2::coin::zero</code> +{' '}
          <code>0x2::coin::destroy_zero</code>. For real dApp targets, use manual entry below.
        </p>
      </div>

      {/* Manual entry */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <div className="promo-input-group">
          <label className="promo-label">packageId</label>
          <input
            type="text"
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            placeholder="0x2"
            className="promo-input"
          />
        </div>
        <div className="promo-input-group">
          <label className="promo-label">module</label>
          <input
            type="text"
            value={module}
            onChange={(e) => setModule(e.target.value)}
            placeholder="coin"
            className="promo-input"
          />
        </div>
        <div className="promo-input-group">
          <label className="promo-label">function</label>
          <input
            type="text"
            value={fn}
            onChange={(e) => setFn(e.target.value)}
            placeholder="transfer"
            className="promo-input"
          />
        </div>
      </div>

      <button
        onClick={addTarget}
        disabled={!packageId.trim() || !module.trim() || !fn.trim() || computing}
        className="promo-btn promo-btn-primary"
        style={{ marginTop: 8 }}
      >
        {computing ? '⏳ Computing...' : '➕ Add Target'}
      </button>

      {entries.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="promo-label">Targets ({entries.length})</label>
            <button onClick={clearAll} className="promo-btn-icon" title="Clear all">
              🗑️
            </button>
          </div>
          <div className="promo-targets-list">
            {entries.map((e) => (
              <div key={e.hash} className="promo-target-entry">
                <div>
                  <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {e.canonical}
                  </code>
                  <br />
                  <code style={{ fontSize: 11, color: 'var(--accent-green)' }}>
                    sha256: {e.hash}
                  </code>
                </div>
                <button
                  onClick={() => removeEntry_cb(e.hash)}
                  className="promo-btn-icon"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="promo-input-group" style={{ marginTop: 12 }}>
            <label className="promo-label">
              Comma-separated hashes (for promotion allowedTargets)
            </label>
            <input
              type="text"
              readOnly
              value={allHashes}
              className="promo-input"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
