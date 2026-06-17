/**
 * DeveloperJwtPanel — Developer JWT paste input.
 *
 * Single-purpose component: paste a developer-signed JWT token.
 * The developer JWT is signed by the app developer (host) using their
 * private key and verified server-side via asymmetric trust config.
 *
 * There is no "issue" tab — developers generate JWTs in their own backend.
 */

interface DeveloperJwtPanelProps {
  jwt: string;
  onJwtChange: (jwt: string) => void;
}

export function DeveloperJwtPanel({ jwt, onJwtChange }: DeveloperJwtPanelProps) {
  return (
    <div className="promo-panel">
      <h3 className="promo-panel-title">🔑 Developer JWT</h3>

      <p className="promo-panel-desc">
        Paste a developer-signed JWT below. Generate this token in your backend using your private
        key (RS256 or ES256).
      </p>
      <textarea
        value={jwt}
        onChange={(e) => onJwtChange(e.target.value)}
        placeholder="eyJhbGciOiJSUzI1NiIs..."
        rows={3}
        className="promo-input promo-textarea"
      />

      {jwt && (
        <div className="promo-jwt-preview">
          <label className="promo-label">Current JWT</label>
          <code className="promo-jwt-value">
            {jwt.slice(0, 40)}...{jwt.slice(-20)}
          </code>
        </div>
      )}
    </div>
  );
}
