/**
 * DebugPanel — prepare/sponsor response inspector.
 *
 * Purpose: execution verification, not marketing UI.
 * Highlights: receiptId, policyHash, profile, digest, error codes.
 */

interface DebugEntry {
  label: string;
  request?: unknown;
  response?: unknown;
  error?: string;
  timestamp: number;
}

interface DebugPanelProps {
  entries: DebugEntry[];
}

export function DebugPanel({ entries }: DebugPanelProps) {
  if (entries.length === 0) {
    return (
      <div className="promo-panel">
        <h3 className="promo-panel-title">🔍 Debug Log</h3>
        <p className="promo-panel-desc">
          Request/response details will appear here after execution.
        </p>
      </div>
    );
  }

  return (
    <div className="promo-panel">
      <h3 className="promo-panel-title">🔍 Debug Log</h3>
      <div className="promo-debug-list">
        {entries.map((entry, i) => (
          <div key={i} className="promo-debug-entry">
            <div className="promo-debug-header">
              <span className={`promo-debug-label ${entry.error ? 'error' : 'ok'}`}>
                {entry.error ? '❌' : '✅'} {entry.label}
              </span>
              <span className="promo-debug-time">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
            </div>

            {entry.response != null && (
              <details open={i === entries.length - 1}>
                <summary className="promo-debug-summary">Response</summary>
                <pre className="promo-debug-json">
                  {`${JSON.stringify(entry.response, null, 2)}`}
                </pre>
              </details>
            )}

            {entry.request != null && (
              <details>
                <summary className="promo-debug-summary">Request</summary>
                <pre className="promo-debug-json">
                  {`${JSON.stringify(entry.request, null, 2)}`}
                </pre>
              </details>
            )}

            {entry.error && (
              <div className="promo-status promo-status-error" style={{ marginTop: 4 }}>
                {entry.error}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export type { DebugEntry };
