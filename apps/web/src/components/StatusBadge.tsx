type StatusTone =
  | 'success'
  | 'running'
  | 'failed'
  | 'warning'
  | 'pending'
  | 'neutral'
  | 'skipped';

const TONE_BY_STATUS: Record<string, StatusTone> = {
  ok: 'success',
  ready: 'success',
  success: 'success',
  connected: 'success',
  available: 'success',
  running: 'running',
  indexing: 'running',
  loading: 'running',
  connecting: 'running',
  failed: 'failed',
  error: 'failed',
  disconnected: 'failed',
  stale: 'warning',
  warning: 'warning',
  pending: 'pending',
  idle: 'pending',
  not_indexed: 'pending',
  unavailable: 'neutral',
  skipped: 'skipped',
  rolled_back: 'skipped',
};

const LABEL_BY_STATUS: Record<string, string> = {
  ok: 'ok',
  ready: 'listo',
  success: 'éxito',
  connected: 'conectado',
  available: 'disponible',
  running: 'en curso',
  indexing: 'indexando',
  loading: 'cargando',
  connecting: 'conectando',
  failed: 'fallido',
  error: 'error',
  disconnected: 'desconectado',
  stale: 'desactualizado',
  warning: 'aviso',
  pending: 'pendiente',
  idle: 'inactivo',
  not_indexed: 'sin indexar',
  unavailable: 'no disponible',
  skipped: 'omitido',
  rolled_back: 'revertido',
};

export interface StatusBadgeProps {
  status: string;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const normalized = status.trim().toLowerCase();
  const tone = TONE_BY_STATUS[normalized] ?? 'neutral';
  const text = label ?? LABEL_BY_STATUS[normalized] ?? status;

  return (
    <span
      className={['status-badge', `status-badge--${tone}`, className]
        .filter(Boolean)
        .join(' ')}
      data-status={normalized}
    >
      <span className="status-badge__dot" aria-hidden="true" />
      <span className="status-badge__label">{text}</span>
    </span>
  );
}
