import { useEffect, useRef } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#1e2635',
    primaryTextColor: '#e6edf3',
    textColor: '#e6edf3',
    nodeTextColor: '#e6edf3',
    titleColor: '#e6edf3',
    primaryBorderColor: '#30363d',
    lineColor: '#58a6ff',
    secondaryColor: '#161b22',
    tertiaryColor: '#0d1117',
    edgeLabelBackground: '#161b22',
    noteBkgColor: '#161b22',
    noteTextColor: '#e6edf3',
    actorBkg: '#1e2635',
    actorBorder: '#58a6ff',
    actorTextColor: '#e6edf3',
    actorLineColor: '#30363d',
    signalColor: '#58a6ff',
    signalTextColor: '#e6edf3',
    sequenceNumberColor: '#fff',
  },
  sequence: {
    actorMargin: 80,
    messageMargin: 30,
    mirrorActors: true,
    showSequenceNumbers: true,
    useMaxWidth: true,
    width: 150,
  },
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true,
  },
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 12,
});

interface MermaidProps {
  chart: string;
  className?: string;
}

/**
 * Mermaid renderer.
 *
 * Chart definitions are hardcoded in source (not user input),
 * so DOMPurify sanitization is unnecessary and was stripping
 * flowchart text content.
 */
export function Mermaid({ chart, className }: MermaidProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    ref.current.innerHTML = '';

    mermaid.render(id, chart).then(({ svg }) => {
      if (ref.current) {
        ref.current.innerHTML = svg;

        // Make SVG responsive
        const svgEl = ref.current.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
        }
      }
    });
  }, [chart]);

  return <div ref={ref} className={className} />;
}
