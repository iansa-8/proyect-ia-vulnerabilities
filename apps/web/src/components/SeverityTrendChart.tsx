import type { QualitySnapshotView } from '../api';

const SEVERITY_ORDER = [
  'BLOCKER',
  'CRITICAL',
  'MAJOR',
  'HIGH',
  'MINOR',
  'MEDIUM',
  'INFO',
  'LOW',
];

const SEVERITY_COLORS: Record<string, string> = {
  BLOCKER: '#7f1d1d',
  CRITICAL: '#dc2626',
  MAJOR: '#f97316',
  HIGH: '#f97316',
  MINOR: '#eab308',
  MEDIUM: '#eab308',
  INFO: '#0ea5e9',
  LOW: '#0ea5e9',
};

function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity.toUpperCase()] ?? '#94a3b8';
}

function severityWeight(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity.toUpperCase());
  return index === -1 ? 99 : index;
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
}

function fullDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface SeverityTrendChartProps {
  snapshots: QualitySnapshotView[];
  maxPoints?: number;
}

export function SeverityTrendChart({ snapshots, maxPoints = 24 }: SeverityTrendChartProps) {
  if (!snapshots.length) return null;

  const points = snapshots.slice(0, maxPoints).slice().reverse();
  const severities = Array.from(
    new Set(points.flatMap((point) => Object.keys(point.severityCounts))),
  ).sort((a, b) => severityWeight(a) - severityWeight(b));

  const maxTotal = Math.max(1, ...points.map((point) => total(point.severityCounts)));

  const latest = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const latestTotal = total(latest.severityCounts);
  const delta = previous ? latestTotal - total(previous.severityCounts) : 0;
  const deltaTone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  return (
    <div className="subsection trend-chart-block">
      <div className="trend-chart-block__head">
        <h3 className="subsection-title">Evolución por gravedad</h3>
        <span className="trend-chart-block__meta">
          {points.length} análisis
          {previous ? (
            <span className={`trend-delta trend-delta--${deltaTone}`}>
              {delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '='}
            </span>
          ) : null}
        </span>
      </div>

      <div
        className="trend-chart"
        role="img"
        aria-label="Hallazgos por gravedad a lo largo del tiempo"
      >
        {points.map((point) => {
          const value = total(point.severityCounts);
          return (
            <div
              className="trend-chart__col"
              key={point.id}
              title={`${fullDate(point.createdAt)} · ${value} hallazgos`}
            >
              <div className="trend-chart__plot">
                <div
                  className="trend-chart__bar"
                  style={{ height: `${Math.max(3, (value / maxTotal) * 100)}%` }}
                >
                  {severities.map((severity) => {
                    const count = point.severityCounts[severity] ?? 0;
                    if (!count) return null;
                    return (
                      <span
                        key={severity}
                        className="trend-chart__segment"
                        style={{ flexGrow: count, background: severityColor(severity) }}
                      />
                    );
                  })}
                </div>
              </div>
              <span className="trend-chart__label">{shortDate(point.createdAt)}</span>
            </div>
          );
        })}
      </div>

      <div className="trend-chart__legend">
        {severities.map((severity) => (
          <span key={severity} className="trend-chart__legend-item">
            <span className="trend-chart__dot" style={{ background: severityColor(severity) }} />
            {severity}
          </span>
        ))}
      </div>

      {points.length < 2 ? (
        <p className="text-muted trend-chart-block__hint">
          Ejecuta otro análisis para visualizar la evolución.
        </p>
      ) : null}
    </div>
  );
}
