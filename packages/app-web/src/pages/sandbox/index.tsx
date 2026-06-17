import { lazy, Suspense, useState } from 'react';
import { CodePanel } from './components/CodePanel';
import type { SandboxStep } from './types';

const ExecutionPanel = lazy(() =>
  import('./components/ExecutionPanel').then((m) => ({ default: m.ExecutionPanel })),
);

export function SandboxPage() {
  const [activeStep, setActiveStep] = useState<SandboxStep>('install');
  const [settlementSwapPathIndex, setSettlementSwapPathIndex] = useState(0);

  return (
    <div className="page">
      <h1 className="page-title">Sandbox</h1>
      <p className="page-subtitle">
        Run live token-native settlement flows against the Sui network, and view the corresponding
        SDK reference code on the right.
      </p>

      <style>{`
        .sandbox-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 768px) {
          .sandbox-grid { grid-template-columns: 1fr; }
        }
      `}</style>
      <div className="sandbox-grid">
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: 'var(--text-secondary, #888)',
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            Live Execution
          </div>
          <Suspense
            fallback={
              <div style={{ padding: 24, color: 'var(--text-secondary, #888)', fontSize: 13 }}>
                Loading wallet components...
              </div>
            }
          >
            <ExecutionPanel
              onStepChange={setActiveStep}
              activeStep={activeStep}
              settlementSwapPathIndex={settlementSwapPathIndex}
              onSettlementSwapPathIndexChange={setSettlementSwapPathIndex}
            />
          </Suspense>
        </div>

        <div style={{ position: 'sticky', top: 80 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: 'var(--text-secondary, #888)',
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            SDK Code
          </div>
          <CodePanel
            activeStep={activeStep}
            onStepChange={setActiveStep}
            settlementSwapPathIndex={settlementSwapPathIndex}
          />
        </div>
      </div>
    </div>
  );
}

export default SandboxPage;
