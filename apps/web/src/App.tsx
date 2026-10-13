import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  createQualityProject,
  applyAgentProposal,
  applyAgentProposalsInBulk,
  fetchHealth,
  fetchAgentHealth,
  fetchLLMHealth,
  fetchIndexContext,
  fetchIndexerHealth,
  fetchQualityIssueContext,
  fetchQualityIssues,
  fetchQualityScannerHealth,
  getQualityIssueReport,
  getQualitySnapshot,
  getPipelineRun,
  getProject,
  getProjectIndex,
  getQualityConfig,
  listPipelines,
  listPipelineRuns,
  listQualitySnapshots,
  listProjects,
  listAgentProposals,
  listProjectAgentProposals,
  listFixApplications,
  proposeQualityFix,
  proposeQualityFixesInBulk,
  rejectAgentProposal,
  selectProject,
  startPipelineRun,
  startProjectIndex,
  testQualityConnection,
  updateProjectCommands,
  updateQualityConfig,
  type HealthResponse,
  type AgentHealthView,
  type LLMHealthView,
  type AgentProposalView,
  type BulkProposalView,
  type FixApplicationReportView,
  type IndexContextResultView,
  type IndexerHealthResponse,
  type PipelineDefinitionView,
  type PipelineRunView,
  type ProjectIndexStatusView,
  type ProjectView,
  type QualityConfigView,
  type QualityConnectionTestView,
  type QualityIssueContextView,
  type QualityIssueReportView,
  type QualityIssueView,
  type QualityIssuesPageView,
  type QualityScannerHealthView,
  type QualitySnapshotView,
  type StepRunRecord,
} from './api';
import {
  CodeBlock,
  DiffPreview,
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  LoadingState,
  MetadataList,
  MetadataRow,
  PageHeader,
  PromptViewer,
  Section,
  SeverityTrendChart,
  StatusBadge,
} from './components';
import { buildGraphUrl } from './graph-url';
import { usePlatformSocket } from './usePlatformSocket';

type LoadState = 'idle' | 'loading' | 'ok' | 'error';

type CommandDraft = {
  buildCommand: string;
  testCommand: string;
  coverageCommand: string;
  e2eCommand: string;
  startCommand: string;
};

type NavId =
  | 'proyectos'
  | 'resumen'
  | 'calidad'
  | 'indice'
  | 'contexto'
  | 'pipelines'
  | 'sistema';

const GRAPH_UI_URL =
  (import.meta.env.VITE_CODEBASE_MEMORY_UI_URL as string | undefined)?.trim() ||
  'http://localhost:9749';

const NAV_ITEMS: Array<{ id: NavId; label: string; path: string }> = [
  { id: 'proyectos', label: 'Proyectos', path: '/proyectos' },
  { id: 'resumen', label: 'Resumen', path: '/resumen' },
  { id: 'calidad', label: 'Sonar', path: '/sonar' },
  { id: 'indice', label: 'Índice de código', path: '/indice' },
  { id: 'contexto', label: 'Contexto', path: '/contexto' },
  { id: 'pipelines', label: 'Pipelines', path: '/pipelines' },
  { id: 'sistema', label: 'Sistema', path: '/sistema' },
];

const LAST_PROJECT_KEY = 'amp:last-project-id';

type ActionIconName = 'issues' | 'proposals' | 'connection' | 'save' | 'analysis' | 'expand' | 'dismiss';

function ActionIcon({ name }: { name: ActionIconName }) {
  const paths: Record<ActionIconName, ReactNode> = {
    issues: (
      <>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </>
    ),
    proposals: (
      <>
        <path d="m11 3 1.35 4.15L16.5 8.5l-4.15 1.35L11 14l-1.35-4.15L5.5 8.5l4.15-1.35L11 3Z" />
        <path d="m18.5 14 .75 2.25L21.5 17l-2.25.75L18.5 20l-.75-2.25L15.5 17l2.25-.75L18.5 14Z" />
      </>
    ),
    connection: (
      <>
        <path d="M20 11a8 8 0 0 0-14.9-4" />
        <path d="M5 3v4h4" />
        <path d="M4 13a8 8 0 0 0 14.9 4" />
        <path d="M19 21v-4h-4" />
      </>
    ),
    save: (
      <>
        <path d="M5 3h12l2 2v16H5V3Z" />
        <path d="M8 3v6h8V3M8 21v-7h8v7" />
      </>
    ),
    analysis: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m10 8 6 4-6 4V8Z" />
      </>
    ),
    expand: (
      <>
        <path d="m7 10 5 5 5-5" />
      </>
    ),
    dismiss: (
      <>
        <path d="m7 7 10 10M17 7 7 17" />
      </>
    ),
  };

  return (
    <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function navFromPath(pathname: string): NavId {
  return NAV_ITEMS.find((item) => item.path === pathname)?.id ?? 'proyectos';
}

function navMeta(id: NavId): { title: string; description: string } {
  const metadata: Record<NavId, { title: string; description: string }> = {
    proyectos: { title: 'Proyectos', description: 'Administra los repositorios disponibles para modernización.' },
    resumen: { title: 'Resumen', description: 'Perfil y comandos del proyecto seleccionado.' },
    calidad: { title: 'Sonar', description: 'Configuración, análisis y hallazgos de calidad del proyecto.' },
    indice: { title: 'Índice de código', description: 'Estado de Codebase Memory y acciones de indexación.' },
    contexto: { title: 'Contexto', description: 'Explora símbolos, dependencias y fragmentos relacionados.' },
    pipelines: { title: 'Pipelines', description: 'Ejecuciones controladas y trazabilidad de cada paso.' },
    sistema: { title: 'Sistema', description: 'Estado técnico de los servicios locales.' },
  };
  return metadata[id];
}

function profileToDraft(profile: ProjectView['effectiveProfile']): CommandDraft {
  return {
    buildCommand: profile.buildCommand ?? '',
    testCommand: profile.testCommand ?? '',
    coverageCommand: profile.coverageCommand ?? '',
    e2eCommand: profile.e2eCommand ?? '',
    startCommand: profile.startCommand ?? '',
  };
}

function displayValue(value: string | undefined): string {
  return value && value.trim() ? value : '—';
}

function shortSha(value: string | undefined): string {
  if (!value) {
    return '—';
  }
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function formatStack(profile: ProjectView['effectiveProfile'] | undefined): string {
  if (!profile) {
    return 'Stack no detectado';
  }
  const parts = [profile.framework, profile.runtime, profile.packageManager].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join(' · ') : 'Stack no detectado';
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) {
    return null;
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('es-CL', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function qualityConnectionLabel(status: string): string {
  switch (status) {
    case 'CONNECTED':
      return 'conectado';
    case 'PROJECT_EXISTS':
      return 'proyecto existente';
    case 'SERVER_UNAVAILABLE':
      return 'servidor no disponible';
    case 'AUTHENTICATION_FAILED':
      return 'autenticación fallida';
    case 'PROJECT_NOT_FOUND':
      return 'proyecto no encontrado';
    case 'CREATE_FORBIDDEN':
      return 'sin permiso para crear';
    case 'FORBIDDEN':
      return 'sin permiso';
    case 'TIMEOUT':
      return 'tiempo agotado';
    default:
      return status.toLowerCase().replaceAll('_', ' ');
  }
}

function qualityProjectStateLabel(state: string): string {
  switch (state) {
    case 'not_configured':
      return 'no configurado';
    case 'configured':
      return 'configurado';
    case 'project_missing':
      return 'no encontrado';
    case 'project_ready':
      return 'listo';
    case 'analysis_pending':
      return 'análisis pendiente';
    case 'analysis_processing':
      return 'procesando';
    case 'analyzed':
      return 'analizado';
    case 'failed':
      return 'fallido';
    default:
      return state;
  }
}

function qualityConnectionBadgeStatus(
  status: string,
): 'connected' | 'warning' | 'failed' {
  if (status === 'CONNECTED' || status === 'PROJECT_EXISTS') return 'connected';
  if (status === 'PROJECT_NOT_FOUND') return 'warning';
  return 'failed';
}

const QUALITY_SEVERITY_ORDER = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];

function orderSeverityEntries(
  counts: Record<string, number>,
): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => {
    const indexA = QUALITY_SEVERITY_ORDER.indexOf(a[0].toUpperCase());
    const indexB = QUALITY_SEVERITY_ORDER.indexOf(b[0].toUpperCase());
    return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
  });
}

type SonarStatusTone = 'success' | 'warning' | 'error' | 'neutral';

interface SonarStatusView {
  tone: SonarStatusTone;
  icon: IconName;
  label: string;
  detail: string;
}

/**
 * Deriva un estado general de calidad a partir del último snapshot.
 * Combina hallazgos activos vs. solucionados para reflejar el avance real.
 */
function resolveSonarStatus(
  snapshot: QualitySnapshotView | undefined,
): SonarStatusView {
  if (!snapshot) {
    return {
      tone: 'neutral',
      icon: 'dot',
      label: 'Sin análisis',
      detail: 'Ejecuta un análisis para conocer el estado.',
    };
  }

  const total = snapshot.totalIssues ?? 0;
  const open = snapshot.openIssues ?? 0;
  const resolved = snapshot.resolvedIssues ?? 0;
  const counts = snapshot.severityCounts ?? {};
  const criticalActive = Object.entries(counts).reduce((sum, [key, value]) => {
    const normalized = key.toUpperCase();
    return normalized === 'CRITICAL' || normalized === 'BLOCKER' ? sum + value : sum;
  }, 0);

  if (total === 0) {
    return {
      tone: 'success',
      icon: 'check',
      label: 'Sin hallazgos',
      detail: 'La aplicación no presenta hallazgos.',
    };
  }

  if (open === 0) {
    return {
      tone: 'success',
      icon: 'check',
      label: 'Completado',
      detail: `0 hallazgos activos / ${resolved} solucionados`,
    };
  }

  // Sólo podemos confiar en el desglose por severidad si el snapshot
  // contiene únicamente hallazgos activos (open === total).
  if (open === total && criticalActive > 0) {
    return {
      tone: 'error',
      icon: 'close',
      label: 'Crítico',
      detail: `${open} hallazgos activos / ${criticalActive} críticos`,
    };
  }

  if (resolved > 0) {
    return {
      tone: 'warning',
      icon: 'spinner',
      label: 'En progreso',
      detail: `${open} hallazgos activos / ${resolved} solucionados`,
    };
  }

  return {
    tone: 'warning',
    icon: 'clock',
    label: 'Pendiente',
    detail: `${open} hallazgos activos / 0 solucionados`,
  };
}

function baselineStepLabel(stepId: string): string {
  switch (stepId) {
    case 'load-project':
    case 'validate-directory':
    case 'check-quality-provider':
    case 'ensure-quality-project':
    case 'check-quality-analyzer':
      return 'Preparando';
    case 'run-quality-analysis':
      return 'Ejecutando scanner';
    case 'wait-quality-processing':
      return 'Procesando en Sonar';
    case 'download-quality-issues':
      return 'Descargando issues';
    case 'create-quality-snapshot':
      return 'Creando snapshot';
    case 'load-quality-issue':
    case 'check-code-index':
    case 'resolve-quality-context':
      return 'Preparando contexto';
    case 'check-agent-provider':
      return 'Verificando agente';
    case 'capture-working-tree-baseline':
      return 'Capturando estado del repositorio';
    case 'propose-fix':
      return 'Analizando';
    case 'verify-repository-unchanged':
      return 'Verificando repositorio sin cambios';
    case 'persist-agent-proposal':
      return 'Validando y guardando propuesta';
    case 'load-approved-proposal':
      return 'Cargando propuesta aprobada';
    case 'load-bulk-approved-proposals':
      return 'Cargando propuestas seleccionadas';
    case 'validate-approved-proposal':
      return 'Verificando vigencia y alcance';
    case 'validate-bulk-approved-proposals':
      return 'Verificando vigencia del lote';
    case 'capture-git-baseline':
      return 'Capturando checkpoint Git';
    case 'check-apply-agent-provider':
      return 'Verificando aplicador del fix';
    case 'check-bulk-apply-agent-provider':
      return 'Verificando agente para el lote';
    case 'apply-approved-fix':
      return 'Aplicando fix';
    case 'apply-bulk-approved-fixes':
      return 'Aplicando propuestas en una ejecución';
    case 'capture-run-changes':
      return 'Capturando cambios';
    case 'validate-change-scope':
      return 'Validando alcance';
    case 'validate-fix-build':
      return 'Build';
    case 'validate-fix-unit':
      return 'Unit tests';
    case 'validate-fix-e2e':
      return 'E2E tests';
    case 'validate-fix-startup':
      return 'Startup';
    case 'validate-fix-health':
      return 'Health check';
    case 'compare-quality-snapshots':
      return 'Comparando BEFORE / AFTER';
    case 'compare-bulk-quality-snapshots':
      return 'Comparando todos los hallazgos';
    case 'generate-fix-report':
      return 'Generando reporte';
    case 'complete':
      return 'Completado';
    default:
      return stepId;
  }
}

function baselineStepDescription(stepId: string): string {
  switch (stepId) {
    case 'load-project': return 'Cargando proyecto';
    case 'validate-directory': return 'Validando directorio';
    case 'check-quality-provider': return 'Comprobando proveedor de calidad';
    case 'ensure-quality-project': return 'Verificando proyecto en Sonar';
    case 'check-quality-analyzer': return 'Comprobando analizador de calidad';
    case 'run-quality-analysis': return 'Ejecutando análisis de calidad';
    case 'wait-quality-processing': return 'Esperando procesamiento de Sonar';
    case 'download-quality-issues': return 'Descargando hallazgos';
    case 'create-quality-snapshot': return 'Guardando captura de calidad';
    case 'complete': return 'Análisis finalizado';
    default: return baselineStepLabel(stepId);
  }
}

function stepStatusLabel(status: string): string {
  switch (status) {
    case 'success': return 'Éxito';
    case 'running': return 'En curso';
    case 'failed': return 'Fallido';
    case 'skipped': return 'Omitido';
    case 'rolled_back': return 'Revertido';
    case 'pending': return 'Pendiente';
    default: return status.replaceAll('_', ' ');
  }
}

function stepStatusIcon(status: string): IconName {
  switch (status) {
    case 'success': return 'check';
    case 'running': return 'spinner';
    case 'failed': return 'close';
    case 'skipped': return 'minus';
    case 'rolled_back': return 'undo';
    case 'pending': return 'clock';
    default: return 'dot';
  }
}

function StepStatusBadge({ status }: { status: string }) {
  const label = stepStatusLabel(status);
  return (
    <span
      className={`step-status step-status--${status}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon name={stepStatusIcon(status)} size={14} />
    </span>
  );
}

function runningStepLabel(event: { type: string; summary: string } | null): string {
  if (!event || event.type !== 'step.started') return 'Preparando contexto';
  try {
    const payload = JSON.parse(event.summary) as { stepId?: string };
    return payload.stepId ? baselineStepLabel(payload.stepId) : 'Preparando contexto';
  } catch {
    return 'Preparando contexto';
  }
}

function isResolvedIssue(issue: QualityIssueView | null | undefined): boolean {
  return ['CLOSED', 'RESOLVED'].includes(String(issue?.status ?? '').toUpperCase());
}

function matchesIssueStatus(issue: QualityIssueView, filter: 'open' | 'resolved' | 'all'): boolean {
  if (filter === 'all') return true;
  return filter === 'resolved' ? isResolvedIssue(issue) : !isResolvedIssue(issue);
}

function qualityPageFromSnapshot(issues: QualityIssueView[]): QualityIssuesPageView {
  const severityCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const issue of issues) {
    severityCounts[issue.severity] = (severityCounts[issue.severity] ?? 0) + 1;
    if (issue.type) typeCounts[issue.type] = (typeCounts[issue.type] ?? 0) + 1;
  }
  return { issues, page: 1, pageSize: issues.length, total: issues.length, hasMore: false, severityCounts, typeCounts };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'hallazgo';
}

function buildIssueReportHtml(report: QualityIssueReportView): string {
  const escape = (value: unknown) => String(value ?? '—')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const issue = report.issue;
  const latestApplication = report.applications[0];
  const latestProposal = report.proposals[0];
  const validationRows = latestApplication?.data.validations
    ? Object.entries(latestApplication.data.validations).map(([name, value]) =>
      `<tr><td>${escape(name)}</td><td>${escape(value.status)}</td><td>${escape(value.summary)}</td><td>${escape(value.durationMs)} ms</td></tr>`).join('')
    : '<tr><td colspan="4">Sin validaciones registradas</td></tr>';
  const changes = report.proposals.flatMap((proposal) => proposal.proposedChanges)
    .map((change) => `<li><code>${escape(change.file)}</code>: ${escape(change.description)}${change.rationale ? `<br><small>${escape(change.rationale)}</small>` : ''}</li>`).join('');
  const history = report.snapshotHistory.map((item) =>
    `<tr><td>${escape(formatTimestamp(item.snapshotCreatedAt))}</td><td>${escape(item.status)}</td><td>${escape(item.severity)}</td><td>${escape(item.snapshotTotalIssues)}</td></tr>`).join('');
  const raw = escape(JSON.stringify({ proposals: report.proposals, applications: report.applications }, null, 2));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe ${escape(issue.rule)}</title><style>
    body{font:14px/1.5 system-ui,sans-serif;color:#18212f;max-width:1050px;margin:32px auto;padding:0 24px}h1,h2{color:#123b5d}h1{margin-bottom:4px}.meta{color:#617084;margin-top:0}.status{display:inline-block;padding:5px 10px;border-radius:999px;background:${report.resolution.resolved ? '#dcfce7' : '#fee2e2'};color:${report.resolution.resolved ? '#166534' : '#991b1b'};font-weight:700}section{border:1px solid #d9e2ec;border-radius:12px;padding:18px;margin:16px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e5eaf0;padding:8px;vertical-align:top}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;background:#f6f8fa;padding:14px;border-radius:8px;overflow:auto}small{color:#617084}</style></head><body>
    <h1>Informe de hallazgo ${escape(issue.rule)}</h1><p class="meta">Generado ${escape(formatTimestamp(report.generatedAt))} desde SQLite · Sin uso de IA</p>
    <p><span class="status">${report.resolution.resolved ? 'SOLUCIONADO' : 'ABIERTO'}</span></p>
    <section><h2>Problema</h2><table><tr><th>ID</th><td>${escape(issue.id)}</td><th>Estado</th><td>${escape(report.resolution.currentStatus)}</td></tr><tr><th>Regla</th><td>${escape(issue.rule)}</td><th>Severidad</th><td>${escape(issue.severity)}</td></tr><tr><th>Tipo</th><td>${escape(issue.type)}</td><th>Esfuerzo</th><td>${escape(issue.effort)}</td></tr><tr><th>Archivo</th><td colspan="3"><code>${escape(issue.file)}${issue.line != null ? `:${issue.line}` : ''}</code></td></tr></table><p>${escape(report.resolution.problem)}</p></section>
    <section><h2>Solución registrada</h2><p>${escape(report.resolution.solution ?? 'Todavía no existe una corrección aplicada para este hallazgo.')}</p>${changes ? `<ul>${changes}</ul>` : '<p>Sin cambios propuestos registrados.</p>'}<p><strong>Proveedor de propuesta:</strong> ${escape(latestProposal?.provider)} · <strong>Aplicación:</strong> ${escape(latestApplication?.status)}</p></section>
    <section><h2>Validaciones</h2><table><thead><tr><th>Validación</th><th>Estado</th><th>Resultado</th><th>Duración</th></tr></thead><tbody>${validationRows}</tbody></table></section>
    <section><h2>Historial en Sonar</h2><p>Primera aparición: ${escape(formatTimestamp(report.resolution.firstSeenAt))} · Última aparición: ${escape(formatTimestamp(report.resolution.lastSeenAt))}</p><table><thead><tr><th>Snapshot</th><th>Estado</th><th>Severidad</th><th>Total del proyecto</th></tr></thead><tbody>${history}</tbody></table></section>
    <section><h2>Trazabilidad completa persistida</h2><p>Propuestas: ${report.proposals.length} · Aplicaciones: ${report.applications.length}</p><details><summary>Ver datos técnicos</summary><pre>${raw}</pre></details></section>
  </body></html>`;
}

export function App() {
  const [healthState, setHealthState] = useState<LoadState>('idle');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const { status: wsStatus, lastEvent } = usePlatformSocket();

  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectView | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [savingCommands, setSavingCommands] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [pipelines, setPipelines] = useState<PipelineDefinitionView[]>([]);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [pipelineRun, setPipelineRun] = useState<PipelineRunView | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  const [indexerHealth, setIndexerHealth] = useState<IndexerHealthResponse | null>(null);
  const [indexStatus, setIndexStatus] = useState<ProjectIndexStatusView | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState('');
  const [contextResult, setContextResult] = useState<IndexContextResultView | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [searchingContext, setSearchingContext] = useState(false);

  const [qualityConfig, setQualityConfig] = useState<QualityConfigView | null>(null);
  const [qualityProjectKey, setQualityProjectKey] = useState('');
  const [qualityProjectName, setQualityProjectName] = useState('');
  const [qualityAutoCreate, setQualityAutoCreate] = useState(true);
  const [qualityBaseUrlOverride, setQualityBaseUrlOverride] = useState('');
  const [qualityConnection, setQualityConnection] =
    useState<QualityConnectionTestView | null>(null);
  const [scannerHealth, setScannerHealth] = useState<QualityScannerHealthView | null>(null);
  const [qualityIssues, setQualityIssues] = useState<QualityIssuesPageView | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<QualityIssueView | null>(null);
  const [issueContext, setIssueContext] = useState<QualityIssueContextView | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [savingQuality, setSavingQuality] = useState(false);
  const [testingQuality, setTestingQuality] = useState(false);
  const [creatingQualityProject, setCreatingQualityProject] = useState(false);
  const [runningBaseline, setRunningBaseline] = useState(false);
  const [baselineRun, setBaselineRun] = useState<PipelineRunView | null>(null);
  const [snapshots, setSnapshots] = useState<QualitySnapshotView[]>([]);
  const [baselineHistoryError, setBaselineHistoryError] = useState<string | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [loadingIssueContext, setLoadingIssueContext] = useState(false);
  const [issuesAvailable, setIssuesAvailable] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [issueStatusFilter, setIssueStatusFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [downloadingIssueReport, setDownloadingIssueReport] = useState(false);
  const [showBaselineSteps, setShowBaselineSteps] = useState(false);
  const [hideBaselineProgress, setHideBaselineProgress] = useState(false);
  const qualityTestInFlight = useRef(false);
  const issueProposalRequest = useRef(0);
  const [agentHealth, setAgentHealth] = useState<AgentHealthView | null>(null);
  const [llmHealth, setLLMHealth] = useState<LLMHealthView | null>(null);
  const [agentProposal, setAgentProposal] = useState<AgentProposalView | null>(null);
  const [projectProposals, setProjectProposals] = useState<AgentProposalView[]>([]);
  const [proposalRun, setProposalRun] = useState<PipelineRunView | null>(null);
  const [proposingFix, setProposingFix] = useState(false);
  const [proposalExecutionMode, setProposalExecutionMode] = useState<'default' | 'ai' | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [showBulkProposals, setShowBulkProposals] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProposalResult, setBulkProposalResult] = useState<BulkProposalView | null>(null);
  const [bulkProposing, setBulkProposing] = useState(false);
  const [bulkProposalError, setBulkProposalError] = useState<string | null>(null);
  const [bulkApplySelectedIds, setBulkApplySelectedIds] = useState<Set<string>>(new Set());
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkApplyRun, setBulkApplyRun] = useState<PipelineRunView | null>(null);
  const [applyingFix, setApplyingFix] = useState(false);
  const [applyExecutionMode, setApplyExecutionMode] = useState<'default' | 'ai' | null>(null);
  const [fixApplicationRun, setFixApplicationRun] = useState<PipelineRunView | null>(null);
  const [fixApplication, setFixApplication] = useState<FixApplicationReportView | null>(null);

  const [activeNav, setActiveNav] = useState<NavId>(() => navFromPath(window.location.pathname));
  const restoredProject = useRef(false);

  const refreshAgentHealth = useCallback(async () => {
    try {
      const health = await fetchAgentHealth();
      setAgentHealth(health);
      return health;
    } catch {
      setAgentHealth(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshAgentHealth();
    void fetchLLMHealth()
      .then(setLLMHealth)
      .catch(() => setLLMHealth(null));
  }, [refreshAgentHealth]);

  useEffect(() => {
    setProjectProposals([]);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setBaselineRun(null);
    setSnapshots([]);
    setIssuesAvailable(false);
    setShowBaselineSteps(false);
    setHideBaselineProgress(false);
    async function refresh() {
      if (!selectedId) return;
      try {
        const [runs, history] = await Promise.all([
          listPipelineRuns(), listQualitySnapshots(selectedId),
        ]);
        const latest = runs.filter((run) => run.projectId === selectedId
          && run.pipelineDefinitionId === 'sonar-baseline')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const view = latest ? await getPipelineRun(latest.id) : null;
        if (!cancelled) {
          setBaselineRun(view);
          setSnapshots(history);
          if (history.some((snapshot) => snapshot.totalIssues > 0)) {
            setIssuesAvailable(true);
          }
          setBaselineHistoryError(null);
        }
      } catch (err) {
        if (!cancelled) setBaselineHistoryError(err instanceof Error ? err.message : 'No se pudo cargar el historial');
      } finally {
        if (!cancelled && runningBaseline) timer = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [selectedId, runningBaseline]);

  const refreshHealth = useCallback(async () => {
    setHealthState('loading');
    setHealthError(null);
    try {
      const data = await fetchHealth();
      setHealth(data);
      setHealthState('ok');
    } catch (err) {
      setHealth(null);
      setHealthState('error');
      setHealthError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const refreshIndexerHealth = useCallback(async () => {
    try {
      const data = await fetchIndexerHealth();
      setIndexerHealth(data);
    } catch {
      setIndexerHealth(null);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjectsError(null);
    try {
      const data = await listProjects();
      setProjects(data);
    } catch (err) {
      setProjectsError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const refreshPipelines = useCallback(async () => {
    setPipelinesError(null);
    try {
      const data = await listPipelines();
      setPipelines(data);
      setSelectedPipelineId((prev) => prev ?? data[0]?.id ?? null);
    } catch (err) {
      setPipelinesError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const loadIndexStatus = useCallback(async (id: string) => {
    setIndexError(null);
    try {
      const status = await getProjectIndex(id);
      setIndexStatus(status);
    } catch (err) {
      setIndexStatus(null);
      setIndexError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const loadQuality = useCallback(async (id: string) => {
    setQualityError(null);
    setSelectedIssue(null);
    setIssueContext(null);
    setQualityIssues(null);
    setQualityConnection(null);
    setIssuesAvailable(false);
    setShowIssues(false);
    setSeverityFilter(null);
    try {
      const config = await getQualityConfig(id);
      setQualityConfig(config);
      // Precargar sugerencia solo si el usuario aún no guardó una key.
      setQualityProjectKey(
        config.projectKey.trim()
          ? config.projectKey
          : (config.suggestedProjectKey ?? ''),
      );
      setQualityProjectName(config.sonarProjectName ?? '');
      setQualityAutoCreate(config.autoCreateProject);
      setQualityBaseUrlOverride(config.baseUrlOverride ?? '');
      try {
        const scanner = await fetchQualityScannerHealth(id);
        setScannerHealth(scanner);
      } catch {
        setScannerHealth(null);
      }
      try {
        const storedIssues = await fetchQualityIssues(id, { page: 1, pageSize: 1 });
        setIssuesAvailable(storedIssues.total > 0);
      } catch {
        // El historial de snapshots sigue siendo un respaldo válido para habilitar el acceso.
      }
    } catch (err) {
      setQualityConfig(null);
      setQualityError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const loadOverview = useCallback(
    async (id: string) => {
      setOverviewError(null);
      setSaveMessage(null);
      setContextResult(null);
      setContextError(null);
      try {
        const data = await getProject(id);
        setSelected(data);
        setSelectedId(data.id);
        window.localStorage.setItem(LAST_PROJECT_KEY, data.id);
        setDraft(profileToDraft(data.effectiveProfile));
        await loadIndexStatus(data.id);
        await loadQuality(data.id);
      } catch (err) {
        setSelected(null);
        setDraft(null);
        setOverviewError(err instanceof Error ? err.message : 'Error desconocido');
      }
    },
    [loadIndexStatus, loadQuality],
  );

  useEffect(() => {
    void refreshHealth();
    void refreshIndexerHealth();
    void refreshProjects();
    void refreshPipelines();
  }, [refreshHealth, refreshIndexerHealth, refreshProjects, refreshPipelines]);

  useEffect(() => {
    if (window.location.pathname === '/' || !NAV_ITEMS.some((item) => item.path === window.location.pathname)) {
      window.history.replaceState({}, '', NAV_ITEMS.find((item) => item.id === activeNav)?.path ?? '/proyectos');
    }
    const onPopState = () => setActiveNav(navFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (restoredProject.current || projects.length === 0 || selectedId) return;
    restoredProject.current = true;
    const storedId = window.localStorage.getItem(LAST_PROJECT_KEY);
    const fallback = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const project = projects.find((item) => item.id === storedId) ?? fallback;
    if (project) void loadOverview(project.id);
  }, [loadOverview, projects, selectedId]);

  const onSelectProject = async (event: FormEvent) => {
    event.preventDefault();
    setSelecting(true);
    setSelectError(null);
    setSaveMessage(null);
    try {
      const project = await selectProject(pathInput.trim());
      setPathInput(project.path);
      await refreshProjects();
      await loadOverview(project.id);
      onNavClick('resumen');
    } catch (err) {
      setSelectError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSelecting(false);
    }
  };

  const onSaveCommands = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !draft) {
      return;
    }
    setSavingCommands(true);
    setSaveMessage(null);
    setOverviewError(null);
    try {
      const updated = await updateProjectCommands(selected.id, draft);
      setSelected(updated);
      setDraft(profileToDraft(updated.effectiveProfile));
      await refreshProjects();
      setSaveMessage('Comandos guardados.');
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSavingCommands(false);
    }
  };

  const onRunPipeline = async () => {
    if (!selectedId || !selectedPipelineId) {
      return;
    }
    setRunningPipeline(true);
    setPipelineError(null);
    setPipelineRun(null);
    try {
      const view = await startPipelineRun(selectedPipelineId, selectedId);
      setPipelineRun(view);
      const refreshed = await getPipelineRun(view.run.id);
      setPipelineRun(refreshed);
      setBaselineRun(refreshed);
      if (selectedPipelineId === 'project-indexing') {
        await loadIndexStatus(selectedId);
        await refreshIndexerHealth();
      }
      if (selectedPipelineId === 'quality-analysis' || selectedPipelineId === 'sonar-baseline') {
        await loadQuality(selectedId);
      }
    } catch (err) {
      setPipelineError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRunningPipeline(false);
    }
  };

  const onIndexProject = async (forceReindex: boolean) => {
    if (!selectedId) {
      return;
    }
    setIndexing(true);
    setIndexError(null);
    try {
      const view = await startProjectIndex(selectedId, forceReindex);
      setPipelineRun(view);
      setSelectedPipelineId('project-indexing');
      await loadIndexStatus(selectedId);
      await refreshIndexerHealth();
    } catch (err) {
      setIndexError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setIndexing(false);
    }
  };

  const onSearchContext = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !symbolQuery.trim()) {
      return;
    }
    setSearchingContext(true);
    setContextError(null);
    try {
      const result = await fetchIndexContext(selectedId, symbolQuery.trim());
      setContextResult(result);
    } catch (err) {
      setContextResult(null);
      setContextError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSearchingContext(false);
    }
  };

  const onSaveQuality = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId) {
      return;
    }
    setSavingQuality(true);
    setQualityError(null);
    try {
      const config = await updateQualityConfig(selectedId, {
        projectKey: qualityProjectKey.trim(),
        sonarProjectName: qualityProjectName.trim() || null,
        autoCreateProject: qualityAutoCreate,
        baseUrlOverride: qualityBaseUrlOverride.trim() || null,
      });
      setQualityConfig(config);
      setQualityProjectKey(config.projectKey);
      setQualityProjectName(config.sonarProjectName ?? '');
      setQualityAutoCreate(config.autoCreateProject);
      setQualityBaseUrlOverride(config.baseUrlOverride ?? '');
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSavingQuality(false);
    }
  };

  const onCreateQualityProject = async () => {
    if (!selectedId) {
      return;
    }
    setCreatingQualityProject(true);
    setQualityError(null);
    try {
      await updateQualityConfig(selectedId, {
        projectKey: qualityProjectKey.trim(),
        sonarProjectName: qualityProjectName.trim() || null,
        autoCreateProject: qualityAutoCreate,
        baseUrlOverride: qualityBaseUrlOverride.trim() || null,
      });
      const created = await createQualityProject(selectedId);
      const result = await testQualityConnection(selectedId);
      setQualityConnection(result);
      if (created.project) {
        setQualityConfig((prev) =>
          prev
            ? {
              ...prev,
              projectState: 'project_ready',
            }
            : prev,
        );
      }
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setCreatingQualityProject(false);
    }
  };

  const onRunSonarBaseline = async () => {
    if (!selectedId) {
      return;
    }
    setRunningBaseline(true);
    setShowBaselineSteps(false);
    setHideBaselineProgress(false);
    setPipelineError(null);
    setSelectedPipelineId('sonar-baseline');
    try {
      const view = await startPipelineRun('sonar-baseline', selectedId);
      setPipelineRun(view);
      const refreshed = await getPipelineRun(view.run.id);
      setPipelineRun(refreshed);
      await loadQuality(selectedId);
      if (refreshed.run.status === 'success') {
        const history = await listQualitySnapshots(selectedId);
        setSnapshots(history);
        setIssuesAvailable(history.some((snapshot) => snapshot.totalIssues > 0));
        setShowIssues(false);
      }
    } catch (err) {
      setPipelineError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRunningBaseline(false);
    }
  };

  const onTestQuality = async () => {
    if (!selectedId || qualityTestInFlight.current) {
      return;
    }
    qualityTestInFlight.current = true;
    setTestingQuality(true);
    setQualityError(null);
    try {
      const result = await testQualityConnection(selectedId);
      setQualityConnection(result);
    } catch (err) {
      setQualityConnection(null);
      setQualityError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      qualityTestInFlight.current = false;
      setTestingQuality(false);
    }
  };

  useEffect(() => {
    if (activeNav !== 'calidad' || !selectedId) return;
    const refreshSonarMenu = () => {
      void onTestQuality();
      void listQualitySnapshots(selectedId).then((history) => {
        setSnapshots(history);
        setIssuesAvailable(history.some((snapshot) => snapshot.totalIssues > 0));
      }).catch(() => undefined);
    };
    refreshSonarMenu();
    const timer = window.setInterval(refreshSonarMenu, 30_000);
    return () => window.clearInterval(timer);
  }, [activeNav, selectedId]);

  useEffect(() => {
    if (!showIssues && !showBulkProposals) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showBulkProposals) setShowBulkProposals(false);
        else setShowIssues(false);
      }
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [showIssues, showBulkProposals]);

  const onOpenIssues = async () => {
    if (!selectedId) {
      return;
    }
    setShowIssues(true);
    setSeverityFilter(null);
    setIssueStatusFilter('open');
    setLoadingIssues(true);
    setQualityError(null);
    try {
      const [history, proposals] = await Promise.all([
        listQualitySnapshots(selectedId),
        listProjectAgentProposals(selectedId),
        refreshAgentHealth(),
      ]);
      setSnapshots(history);
      setProjectProposals(proposals);
      const detail = history[0] ? await getQualitySnapshot(selectedId, history[0].id) : null;
      const page = qualityPageFromSnapshot(detail?.issues ?? []);
      setQualityIssues(page);
      const firstOpen = page.issues.find((issue) => !isResolvedIssue(issue));
      if (firstOpen) onSelectIssue(firstOpen);
      else clearIssueSelection();
    } catch (err) {
      setQualityIssues(null);
      setQualityError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoadingIssues(false);
    }
  };

  const onOpenBulkProposals = async () => {
    if (!selectedId) return;
    setShowBulkProposals(true);
    setBulkProposalResult(null);
    setBulkProposalError(null);
    setLoadingIssues(true);
    try {
      const [history, proposals] = await Promise.all([
        listQualitySnapshots(selectedId),
        listProjectAgentProposals(selectedId),
        refreshAgentHealth(),
      ]);
      setSnapshots(history);
      setProjectProposals(proposals);
      const detail = history[0] ? await getQualitySnapshot(selectedId, history[0].id) : null;
      const page = qualityPageFromSnapshot(detail?.issues ?? []);
      setQualityIssues(page);
      const proposedIssueIds = new Set(proposals
        .filter((proposal) => proposal.status === 'completed' || proposal.status === 'approved')
        .map((proposal) => proposal.issueId));
      setBulkSelectedIds(new Set(page.issues
        .filter((issue) => !isResolvedIssue(issue) && !proposedIssueIds.has(issue.id))
        .map((issue) => issue.id)));
      setBulkApplySelectedIds(new Set(proposals
        .filter((proposal) => (proposal.status === 'completed' || proposal.status === 'approved')
          && page.issues.some((issue) => issue.id === proposal.issueId && !isResolvedIssue(issue)))
        .map((proposal) => proposal.id)));
      setBulkApplyRun(null);
    } catch (err) {
      setBulkSelectedIds(new Set());
      setBulkProposalError(err instanceof Error ? err.message : 'No se pudo cargar el reporte Sonar');
    } finally {
      setLoadingIssues(false);
    }
  };

  const onApplyBulkProposals = async () => {
    if (!selectedId || bulkApplySelectedIds.size === 0) return;
    const selectedProposals = projectProposals.filter((proposal) => bulkApplySelectedIds.has(proposal.id));
    const files = [...new Set(selectedProposals.flatMap((proposal) => proposal.affectedFiles))];
    const approved = window.confirm(
      `OpenCode aplicará ${selectedProposals.length} propuestas en una sola ejecución sobre ${files.length} archivo(s).\n\n`
      + 'La plataforma ejecutará build, tests y Sonar una sola vez. Si falla una validación obligatoria, revertirá todo el lote.',
    );
    if (!approved) return;
    setBulkApplying(true);
    setBulkProposalError(null);
    setBulkApplyRun(null);
    try {
      const run = await applyAgentProposalsInBulk(selectedId, [...bulkApplySelectedIds]);
      setBulkApplyRun(run);
      if (run.run.status !== 'success') throw new Error(run.run.error ?? 'No se pudo aplicar el lote');
      const [history, proposals] = await Promise.all([
        listQualitySnapshots(selectedId),
        listProjectAgentProposals(selectedId),
      ]);
      setSnapshots(history);
      setProjectProposals(proposals);
      if (history[0]) {
        const detail = await getQualitySnapshot(selectedId, history[0].id);
        setQualityIssues(qualityPageFromSnapshot(detail.issues));
      }
      setBulkApplySelectedIds(new Set());
    } catch (err) {
      setBulkProposalError(err instanceof Error ? err.message : 'No se pudo aplicar el lote');
    } finally {
      setBulkApplying(false);
    }
  };

  const onToggleBulkIssue = (issueId: string) => {
    if (latestProposalByIssue.has(issueId)) return;
    setBulkSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  };

  const onReviewExistingProposal = async (proposal: AgentProposalView) => {
    if (!selectedId) return;
    const issue = qualityIssues?.issues.find((item) => item.id === proposal.issueId);
    if (!issue) return;
    setShowBulkProposals(false);
    setShowIssues(true);
    onSelectIssue(issue);
    setAgentProposal(proposal);
    try {
      const applications = await listFixApplications(selectedId, issue.id, proposal.id);
      setFixApplication(applications[0] ?? null);
    } catch {
      setFixApplication(null);
    }
  };

  const onProposeBulkFixes = async () => {
    if (!selectedId || bulkSelectedIds.size === 0) return;
    setBulkProposing(true);
    setBulkProposalError(null);
    setBulkProposalResult(null);
    try {
      const result = await proposeQualityFixesInBulk(selectedId, [...bulkSelectedIds]);
      setBulkProposalResult(result);
      const proposals = await listProjectAgentProposals(selectedId);
      setProjectProposals(proposals);
      const proposedIssueIds = new Set(proposals
        .filter((proposal) => proposal.status === 'completed' || proposal.status === 'approved')
        .map((proposal) => proposal.issueId));
      setBulkSelectedIds((current) => new Set([...current].filter((issueId) => !proposedIssueIds.has(issueId))));
    } catch (err) {
      setBulkProposalError(err instanceof Error ? err.message : 'No se pudieron generar las propuestas');
    } finally {
      setBulkProposing(false);
    }
  };

  function onSelectIssue(issue: QualityIssueView) {
    const requestId = issueProposalRequest.current + 1;
    issueProposalRequest.current = requestId;
    setSelectedIssue(issue);
    setIssueContext(null);
    const cachedProposal = projectProposals.find((item) => item.issueId === issue.id
      && (item.status === 'completed' || item.status === 'approved'))
      ?? projectProposals.find((item) => item.issueId === issue.id)
      ?? null;
    setAgentProposal(cachedProposal);
    setProposalRun(null);
    setProposalError(null);
    setFixApplicationRun(null);
    setFixApplication(null);
    if (selectedId) {
      void refreshAgentHealth();
      void listAgentProposals(selectedId, issue.id)
        .then(async (items) => {
          if (issueProposalRequest.current !== requestId) return;
          const proposal = items.find((item) => item.status === 'completed' || item.status === 'approved') ?? items[0] ?? null;
          setAgentProposal(proposal);
          setProjectProposals((current) => [
            ...items,
            ...current.filter((item) => item.issueId !== issue.id),
          ]);
          if (proposal) {
            const applications = await listFixApplications(selectedId, issue.id, proposal.id);
            if (issueProposalRequest.current !== requestId) return;
            setFixApplication(applications[0] ?? null);
          }
        })
        .catch(() => {
          if (issueProposalRequest.current === requestId) setAgentProposal(cachedProposal);
        });
    }
  }

  const onFilterSeverity = (severity: string) => {
    const nextFilter = severityFilter === severity ? null : severity;
    setSeverityFilter(nextFilter);
    const firstVisible = qualityIssues?.issues.find(
      (issue) => matchesIssueStatus(issue, issueStatusFilter)
        && (!nextFilter || issue.severity.toLowerCase() === nextFilter.toLowerCase()),
    );
    if (firstVisible) onSelectIssue(firstVisible);
    else clearIssueSelection();
  };

  const onFilterIssueStatus = (status: 'open' | 'resolved' | 'all') => {
    setIssueStatusFilter(status);
    const severityStillVisible = qualityIssues?.issues.some(
      (issue) => matchesIssueStatus(issue, status)
        && (!severityFilter || issue.severity.toLowerCase() === severityFilter.toLowerCase()),
    ) ?? false;
    const nextSeverity = severityStillVisible ? severityFilter : null;
    if (!severityStillVisible) setSeverityFilter(null);
    const firstVisible = qualityIssues?.issues.find(
      (issue) => matchesIssueStatus(issue, status)
        && (!nextSeverity || issue.severity.toLowerCase() === nextSeverity.toLowerCase()),
    );
    if (firstVisible) onSelectIssue(firstVisible);
    else clearIssueSelection();
  };

  const onDownloadIssues = async () => {
    if (!selectedId) return;
    setLoadingIssues(true);
    setQualityError(null);
    try {
      const history = await listQualitySnapshots(selectedId);
      const detail = history[0] ? await getQualitySnapshot(selectedId, history[0].id) : null;
      const all = detail?.issues ?? [];
      const columns = ['Severidad', 'Tipo', 'Regla', 'Estado', 'Archivo', 'Línea', 'Mensaje', 'Esfuerzo', 'Creado', 'Actualizado'];
      const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const rows = all.map((issue) => [issue.severity, issue.type, issue.rule, issue.status, issue.file,
      issue.line, issue.message, issue.effort, issue.creationDate, issue.updateDate].map(escape).join(';'));
      const blob = new Blob([`\uFEFF${columns.map(escape).join(';')}\n${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `hallazgos-sonar-${selected?.name ?? 'proyecto'}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : 'No se pudieron descargar los hallazgos');
    } finally {
      setLoadingIssues(false);
    }
  };

  const onLoadIssueContext = async () => {
    if (!selectedId || !selectedIssue) {
      return;
    }
    setLoadingIssueContext(true);
    setQualityError(null);
    try {
      const ctx = await fetchQualityIssueContext(selectedId, selectedIssue.id);
      setIssueContext(ctx);
      if (ctx.codeContext) {
        setContextResult(ctx.codeContext);
      }
    } catch (err) {
      setIssueContext(null);
      setQualityError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoadingIssueContext(false);
    }
  };

  const onProposeFix = async (forceAI = false) => {
    if (!selectedId || !selectedIssue) return;
    if (agentProposal?.contextRevision
      && (agentProposal.status === 'completed' || agentProposal.status === 'approved')) {
      setProposalError('Este hallazgo ya tiene una propuesta vigente. Revísala o aplícala con el agente.');
      return;
    }
    setProposingFix(true);
    setProposalExecutionMode(forceAI ? 'ai' : 'default');
    setProposalError(null);
    setAgentProposal(null);
    try {
      const run = await proposeQualityFix(selectedId, selectedIssue.id, { forceAI });
      setProposalRun(run);
      if (run.run.status !== 'success') {
        const failed = [...run.steps].reverse().find((step) => step.status === 'failed');
        let detail: string | undefined;
        try {
          const parsed = failed?.resultJson
            ? (JSON.parse(failed.resultJson) as { detail?: string })
            : undefined;
          detail = parsed?.detail;
        } catch {
          detail = undefined;
        }
        throw new Error(
          detail
            ? `${run.run.error ?? 'AGENT_EXECUTION_FAILED'}: ${detail}`
            : run.run.error ?? 'La propuesta no pudo completarse',
        );
      }
      const proposals = await listAgentProposals(selectedId, selectedIssue.id);
      setAgentProposal(proposals.find((item) => item.status === 'completed' || item.status === 'approved') ?? proposals[0] ?? null);
      setProjectProposals((current) => [...proposals, ...current.filter((item) => item.issueId !== selectedIssue.id)]);
      if (proposals.length === 0) throw new Error('El pipeline terminó sin una propuesta persistida');
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setProposingFix(false);
      setProposalExecutionMode(null);
    }
  };

  const onDownloadIssueReport = async () => {
    if (!selectedId || !selectedIssue) return;
    setDownloadingIssueReport(true);
    setQualityError(null);
    try {
      const report = await getQualityIssueReport(selectedId, selectedIssue.id);
      const blob = new Blob([buildIssueReportHtml(report)], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `informe-hallazgo-${safeFilename(selectedIssue.rule)}-${safeFilename(selectedIssue.id)}.html`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : 'No se pudo descargar el informe');
    } finally {
      setDownloadingIssueReport(false);
    }
  };

  function clearIssueSelection() {
    issueProposalRequest.current += 1;
    setSelectedIssue(null);
    setIssueContext(null);
    setAgentProposal(null);
    setProposalRun(null);
    setProposalError(null);
    setFixApplicationRun(null);
    setFixApplication(null);
  }

  const onApplyFix = async (forceAgent = false) => {
    if (!selectedId || !selectedIssue || !agentProposal) return;
    const approved = window.confirm(
      `${forceAgent ? 'La IA aplicará la propuesta sobre' : 'Esta operación puede modificar'}:\n\n${agentProposal.affectedFiles.join('\n')}\n\nLa validación se ejecutará automáticamente. Si falla, se revertirán los cambios creados por esta ejecución.`,
    );
    if (!approved) return;
    setApplyingFix(true);
    setApplyExecutionMode(forceAgent ? 'ai' : 'default');
    setProposalError(null);
    try {
      const run = await applyAgentProposal(selectedId, selectedIssue.id, agentProposal.id, { forceAgent });
      setFixApplicationRun(run);
      const applications = await listFixApplications(selectedId, selectedIssue.id, agentProposal.id);
      setFixApplication(applications[0] ?? null);
      const proposals = await listAgentProposals(selectedId, selectedIssue.id);
      setAgentProposal(proposals.find((item) => item.id === agentProposal.id) ?? agentProposal);
      setProjectProposals((current) => [...proposals, ...current.filter((item) => item.issueId !== selectedIssue.id)]);
      if (run.run.status !== 'success') throw new Error(run.run.error ?? 'No se pudo aplicar la corrección');
      const history = await listQualitySnapshots(selectedId);
      setSnapshots(history);
      setIssuesAvailable(history.some((snapshot) => snapshot.totalIssues > 0));
      if (history[0]) {
        const detail = await getQualitySnapshot(selectedId, history[0].id);
        setQualityIssues(qualityPageFromSnapshot(detail.issues));
        const refreshed = detail.issues.find((issue) => issue.id === selectedIssue.id);
        if (refreshed) onSelectIssue(refreshed);
        else clearIssueSelection();
      }
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setApplyingFix(false);
      setApplyExecutionMode(null);
    }
  };

  const onRejectFix = async () => {
    if (!selectedId || !selectedIssue || !agentProposal) return;
    try {
      const rejected = await rejectAgentProposal(selectedId, selectedIssue.id, agentProposal.id);
      setAgentProposal(rejected);
      setProjectProposals((current) => current.map((item) => item.id === rejected.id ? rejected : item));
    } catch (err) { setProposalError(err instanceof Error ? err.message : 'Error desconocido'); }
  };

  const onOpenProject = (id: string) => {
    void loadOverview(id);
    onNavClick('resumen');
  };

  const onNavClick = (id: NavId) => {
    setActiveNav(id);
    const path = NAV_ITEMS.find((item) => item.id === id)?.path ?? '/proyectos';
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const effective = selected?.effectiveProfile;
  const detected = selected?.profile;

  const displaySteps: StepRunRecord[] =
    pipelineRun?.steps ??
    (pipelines.find((p) => p.id === selectedPipelineId)?.steps.map((s, index) => ({
      id: s.stepId,
      runId: '',
      stepId: s.stepId,
      name: s.name,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      resultJson: null,
      error: null,
      stepOrder: index,
    })) ??
      []);

  const callers =
    contextResult?.relations.filter((r) => r.kind === 'caller').map((r) => r.from) ?? [];
  const callees =
    contextResult?.relations.filter((r) => r.kind === 'callee').map((r) => r.to) ?? [];
  const dependencies =
    contextResult?.relations
      .filter((r) => r.kind === 'dependency')
      .map((r) => `${r.from} → ${r.to}`) ?? [];

  const healthBadgeStatus =
    healthState === 'ok' ? 'ok' : healthState === 'loading' ? 'loading' : healthState === 'error' ? 'error' : 'idle';

  const baselineSteps = baselineRun?.steps ?? [];
  const currentBaselineStep =
    baselineSteps.find((step) => step.status === 'running') ??
    [...baselineSteps].reverse().find((step) => step.status !== 'pending') ??
    baselineSteps[0];
  const visibleIssues = qualityIssues?.issues.filter(
    (issue) => {
      if (!matchesIssueStatus(issue, issueStatusFilter)) return false;
      if (severityFilter && issue.severity.toLowerCase() !== severityFilter.toLowerCase()) return false;
      return true;
    }
  ) ?? [];
  const visibleSeverityCounts = (qualityIssues?.issues ?? [])
    .filter((issue) => matchesIssueStatus(issue, issueStatusFilter))
    .reduce<Record<string, number>>((counts, issue) => {
      counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
      return counts;
    }, {});
  const sonarStatus = resolveSonarStatus(snapshots[0]);
  const latestProposalByIssue = new Map<string, AgentProposalView>();
  for (const proposal of projectProposals) {
    if (proposal.contextRevision
      && (proposal.status === 'completed' || proposal.status === 'approved')
      && !latestProposalByIssue.has(proposal.issueId)) {
      latestProposalByIssue.set(proposal.issueId, proposal);
    }
  }
  const bulkOpenIssues = (qualityIssues?.issues ?? []).filter((issue) => !isResolvedIssue(issue));
  const bulkPendingIssues = bulkOpenIssues.filter((issue) => !latestProposalByIssue.has(issue.id));
  const bulkAvailableProposals = bulkOpenIssues
    .map((issue) => latestProposalByIssue.get(issue.id))
    .filter((proposal): proposal is AgentProposalView => Boolean(proposal));
  const hasActiveSelectedProposal = Boolean(agentProposal?.contextRevision
    && (agentProposal.status === 'completed' || agentProposal.status === 'approved'));
  const proposalReady = Boolean(
    agentProposal &&
    ['completed', 'approved'].includes(agentProposal.status) &&
    agentProposal.contextRevision,
  );
  const agentCanApply = Boolean(
    agentHealth?.available && agentHealth.capabilities.includes('apply-fix'),
  );
  const proposalHasPlatformPatch = Boolean(
    agentProposal?.patch &&
    (agentProposal.remediationStrategy === 'local' || agentProposal.remediationStrategy === 'llm'),
  );
  const canApplyNormally = Boolean(
    proposalReady &&
    (agentProposal?.requiresAgent
      ? agentCanApply
      : proposalHasPlatformPatch || (!agentProposal?.remediationStrategy && agentCanApply)),
  );
  const applyUnavailableReason = !agentProposal
    ? null
    : isResolvedIssue(selectedIssue)
      ? 'El hallazgo ya está solucionado.'
      : agentProposal.status === 'rejected'
        ? 'La propuesta fue rechazada.'
        : !agentProposal.contextRevision
          ? 'La propuesta no tiene una revisión de contexto verificable. Genera una nueva propuesta.'
          : agentProposal.requiresAgent && !agentCanApply
            ? agentHealth?.error ?? 'El agente de código no está disponible. Se volverá a comprobar al abrir el hallazgo.'
            : !canApplyNormally
              ? 'La propuesta no contiene un parche aplicable ni requiere ejecución del agente.'
              : null;
  

  const cliAvailable = indexerHealth?.cliAvailable;

  const uiAvailable = indexerHealth?.uiAvailable;
  const graphUrl = buildGraphUrl(
    GRAPH_UI_URL,
    indexStatus?.providerProjectName,
  );

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navegación">
        <div className="sidebar__brand">
          <span className="sidebar__product">AI Modernization Platform</span>
          <span className="sidebar__tagline">Control local · trazabilidad</span>
        </div>

        <nav className="sidebar__nav" aria-label="Secciones">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={item.path}
              className={activeNav === item.id ? 'nav-link is-active' : 'nav-link'}
              onClick={(e) => {
                e.preventDefault();
                onNavClick(item.id);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>

      </aside>

      <main className={`content route-${activeNav}`}>
        <div className="content-inner">
          <PageHeader
            title={navMeta(activeNav).title}
            description={selected ? `${selected.name} · ${navMeta(activeNav).description}` : navMeta(activeNav).description}
            actions={
              <div className="header-statuses" aria-label="Estado de servicios">
                <div className="header-status"><span>API</span><StatusBadge status={healthBadgeStatus} label={healthState === 'ok' ? 'disponible' : healthState === 'loading' ? 'comprobando' : 'sin conexión'} /></div>
                <div className="header-status"><span>WebSocket</span><StatusBadge status={wsStatus} label={wsStatus === 'connected' ? 'conectado' : wsStatus === 'connecting' ? 'conectando' : 'desconectado'} /></div>
              </div>
            }
          />

          <Section

            id="proyectos"
            title="Proyectos"
            description="Registra un repositorio local permitido para analizarlo."
          >
            <form className="form-stack" onSubmit={(e) => void onSelectProject(e)}>
              <div className="field">
                <label className="field__label" htmlFor="project-path">
                  Ruta absoluta del proyecto
                </label>
                <input
                  id="project-path"
                  className="input input--mono"
                  type="text"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  placeholder="C:\ruta\al\repositorio"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="field__hint">
                  Debe estar bajo ALLOWED_PROJECT_ROOTS del agent local.
                </p>
                {selectError ? <p className="field__error">{selectError}</p> : null}
              </div>
              <div className="form-actions" style={{ margin: '10px 0' }}>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={selecting || !pathInput.trim()}
                >
                  {selecting ? 'Analizando…' : 'Registrar proyecto'}
                </button>
                {selecting ? <LoadingState label="Analizando ruta…" /> : null}
              </div>
            </form>

            {projectsError ? <ErrorState message={projectsError} /> : null}

            {projects.length === 0 ? (
              <EmptyState message="Aún no hay proyectos. Registra un repositorio local para analizarlo." />
            ) : (
              <ul className="project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={
                        project.id === selectedId
                          ? 'project-card is-active'
                          : 'project-card'
                      }
                      onClick={() => onOpenProject(project.id)}
                    >
                      <div className="project-card__body">
                        <span className="project-card__name">{project.name}</span>
                        <span className="project-card__stack">
                          {formatStack(project.effectiveProfile)}
                        </span>
                        <span className="project-card__path">{project.path}</span>
                      </div>
                      <span className="project-card__action">Abrir</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {selected && effective && draft ? (
            <>
              <Section
                id="resumen"
                title="Resumen del proyecto"
                description={selected.name}
              >
                <div className="subsection">
                  <h3 className="subsection-title">Perfil</h3>
                  <div className="profile-grid">
                    <div className="profile-item">
                      <span className="profile-item__label">Runtime</span>
                      <span className="profile-item__value">
                        {displayValue(effective.runtime)}
                      </span>
                    </div>
                    <div className="profile-item">
                      <span className="profile-item__label">Framework</span>
                      <span className="profile-item__value">
                        {displayValue(effective.framework)}
                      </span>
                    </div>
                    <div className="profile-item">
                      <span className="profile-item__label">Package manager</span>
                      <span className="profile-item__value">
                        {displayValue(effective.packageManager)}
                      </span>
                    </div>
                  </div>
                  <MetadataList>
                    <MetadataRow label="Ruta" mono>
                      {selected.path}
                    </MetadataRow>
                    <MetadataRow label="Docker">
                      {effective.hasDocker ? 'sí' : 'no'}
                    </MetadataRow>
                    <MetadataRow label="Sonar">
                      {effective.hasSonar ? 'sí' : 'no'}
                    </MetadataRow>
                    <MetadataRow label="Testing detectado">
                      {[
                        detected?.testCommand ? 'test' : null,
                        detected?.coverageCommand ? 'coverage' : null,
                        detected?.e2eCommand ? 'e2e' : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'ninguno'}
                    </MetadataRow>
                  </MetadataList>
                </div>

                <div className="subsection">
                  <h3 className="subsection-title">Comandos</h3>
                  <p className="help-text">
                    Vacío = no ejecutar («Sin configurar»). Los cambios se guardan como
                    overrides.
                  </p>
                  <form className="form-stack" onSubmit={(e) => void onSaveCommands(e)}>
                    {(
                      [
                        ['buildCommand', 'Build'],
                        ['testCommand', 'Test'],
                        ['coverageCommand', 'Coverage'],
                        ['e2eCommand', 'E2E'],
                        ['startCommand', 'Start'],
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key} className="field">
                        <label className="field__label" htmlFor={`cmd-${key}`}>
                          {label}
                        </label>
                        {detected?.[key] ? (
                          <p className="field__hint">Detectado: {detected[key]}</p>
                        ) : null}
                        <input
                          id={`cmd-${key}`}
                          className="input input--mono"
                          type="text"
                          value={draft[key]}
                          onChange={(e) =>
                            setDraft((prev) =>
                              prev ? { ...prev, [key]: e.target.value } : prev,
                            )
                          }
                          placeholder="Sin configurar"
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </div>
                    ))}
                    <div className="form-actions">
                      <button
                        type="submit"
                        className="btn btn--primary"
                        disabled={savingCommands}
                      >
                        {savingCommands ? 'Guardando…' : 'Guardar comandos'}
                      </button>
                      {saveMessage ? (
                        <span className="inline-feedback inline-feedback--ok">
                          {saveMessage}
                        </span>
                      ) : null}
                    </div>
                  </form>
                  {overviewError ? <ErrorState message={overviewError} /> : null}
                </div>
              </Section>

              <Section
                id="calidad"
                title="Sonar"
                description="Configura el proyecto, ejecuta análisis y revisa sus hallazgos."
                actions={
                  <div className="sonar-actions" aria-label="Acciones de Sonar">
                    {issuesAvailable ? (
                      <button type="button" className="sonar-action" disabled={loadingIssues}
                        aria-label={loadingIssues ? 'Cargando hallazgos' : 'Abrir hallazgos'}
                        data-tooltip={loadingIssues ? 'Cargando hallazgos…' : 'Abrir hallazgos'}
                        onClick={() => void onOpenIssues()}>
                        <ActionIcon name="issues" />
                      </button>
                    ) : null}
                    {snapshots.length > 0 ? (
                      <button type="button" className="sonar-action sonar-action--accent"
                        disabled={loadingIssues || llmHealth?.available === false}
                        onClick={() => void onOpenBulkProposals()}
                        aria-label="Proponer soluciones en lote"
                        data-tooltip="Proponer soluciones en lote">
                        <ActionIcon name="proposals" />
                      </button>
                    ) : null}
                    <button type="button" className={`sonar-action${testingQuality ? ' sonar-action--busy' : ''}`}
                      disabled={testingQuality || !selectedId}
                      aria-label={testingQuality ? 'Probando conexión' : 'Probar conexión'}
                      data-tooltip={testingQuality ? 'Probando conexión…' : 'Probar conexión'}
                      onClick={() => void onTestQuality()}>
                      <ActionIcon name="connection" />
                    </button>
                    <button type="submit" form="quality-config-form"
                      className={`sonar-action sonar-action--accent${savingQuality ? ' sonar-action--busy' : ''}`}
                      disabled={savingQuality || !qualityProjectKey.trim()}
                      aria-label={savingQuality ? 'Guardando configuración' : 'Guardar configuración'}
                      data-tooltip={savingQuality ? 'Guardando configuración…' : 'Guardar configuración'}>
                      <ActionIcon name="save" />
                    </button>
                  </div>
                }
              >
               
                
                <div className={`sonar-status sonar-status--${sonarStatus.tone}`} role="status">
                  <span className={`sonar-status__icon sonar-status__icon--${sonarStatus.icon}`}>
                    <Icon name={sonarStatus.icon} size={18} />
                  </span>
                  <div className="sonar-status__text">
                    <strong>{sonarStatus.label}</strong>
                    <span>{sonarStatus.detail}</span>
                  </div>
                </div>

                <div className="sonar-hero">
                  <div className="sonar-hero__main">
                    <div className="sonar-hero__total">
                      <strong>{snapshots[0]?.totalIssues ?? '—'}</strong>
                      <span>Hallazgos</span>
                    </div>
                    <div className="sonar-hero__chips">
                      {snapshots[0] && Object.keys(snapshots[0].severityCounts).length ? (
                        orderSeverityEntries(snapshots[0].severityCounts).map(([severity, count]) => (
                          <span key={severity} className={`severity-chip severity-chip--${severity.toLowerCase()}`}>
                            <strong>{count}</strong>
                            {severity}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted">Sin capturas todavía</span>
                      )}
                    </div>
                  </div>
                  <div className="sonar-hero__actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={runningBaseline || !selectedId}
                      onClick={() => void onRunSonarBaseline()}
                    >
                      <ActionIcon name="analysis" />
                      {runningBaseline ? 'Ejecutando análisis…' : 'Ejecutar análisis'}
                    </button>
                  </div>
                </div>

                {currentBaselineStep && !hideBaselineProgress ? (
                  <div className="analysis-progress">
                    <div className="analysis-progress__header">
                      <StepStatusBadge status={currentBaselineStep.status} />
                      <div className="analysis-progress__text">
                        <strong>{baselineStepLabel(currentBaselineStep.stepId)}</strong>
                        <p>{baselineStepDescription(currentBaselineStep.stepId)}</p>
                      </div>
                      <div className="analysis-progress__actions">
                        <button type="button" className="sonar-action sonar-action--small"
                          onClick={() => setShowBaselineSteps((value) => !value)}
                          aria-label={showBaselineSteps ? 'Ocultar pasos' : 'Ver pasos'}
                          data-tooltip={showBaselineSteps ? 'Ocultar pasos' : 'Ver pasos'}>
                          <ActionIcon name="expand" />
                        </button>
                        <button type="button" className="sonar-action sonar-action--small"
                          onClick={() => setHideBaselineProgress(true)} aria-label="Quitar detalle del análisis"
                          data-tooltip="Quitar detalle">
                          <ActionIcon name="dismiss" />
                        </button>
                      </div>
                    </div>
                    {showBaselineSteps ? (
                      <ol className="analysis-steps">
                        {baselineSteps.map((step: StepRunRecord) => (
                          <li key={step.id} className="analysis-step">
                            <StepStatusBadge status={step.status} />
                            <span className="analysis-step__content">
                              <strong>{baselineStepLabel(step.stepId)}</strong>
                              <small>{baselineStepDescription(step.stepId)}</small>
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                ) : currentBaselineStep ? (
                  <button type="button" className="analysis-progress-restore" onClick={() => setHideBaselineProgress(false)}>
                    Mostrar detalle del último análisis
                  </button>
                ) : null}

                <form id="quality-config-form" className="form-stack sonar-config" onSubmit={(e) => void onSaveQuality(e)}>
                  <div className="field sonar-key-field">
                    <label className="field__label" htmlFor="quality-project-key">
                      Clave del proyecto
                    </label>
                    <input
                      id="quality-project-key"
                      className="input input--mono"
                      type="text"
                      value={qualityProjectKey}
                      onChange={(e) => setQualityProjectKey(e.target.value)}
                      placeholder={
                        qualityConfig?.suggestedProjectKey ??
                        'clave-del-proyecto-en-sonar'
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                {/*     <label className="field field--checkbox" >

                      <span>
                        Crear el proyecto automáticamente cuando aún no exista en Sonar.
                      </span>
                      <input
                        defaultChecked={true}
                        type="checkbox"
                        checked={qualityAutoCreate}
                        onChange={(e) => setQualityAutoCreate(e.target.checked)}
                      />
                    </label> */}
                    {qualityConfig?.suggestedProjectKey &&
                      !qualityConfig.projectKey ? (
                      <p className="text-muted">
                        Sugerencia: {qualityConfig.suggestedProjectKey}
                      </p>
                    ) : null}
                  </div>
                  <div className="sonar-status-line">
                    <span className="sonar-status-line__label">Conexión</span>
                    {qualityConnection ? (
                      <StatusBadge
                        status={qualityConnectionBadgeStatus(qualityConnection.status)}
                        label={qualityConnectionLabel(qualityConnection.status)}
                      />
                    ) : (
                      <span className="text-muted">no probada</span>
                    )}
                    {qualityConnection?.project ? (
                      <span className="sonar-status-line__project mono">
                        {qualityConnection.project.key}
                      </span>
                    ) : null}
                  </div>


                  {qualityConfig?.authenticationConfigured &&
                    (qualityConnection?.status === 'PROJECT_NOT_FOUND' ||
                      qualityConfig.projectState === 'project_missing') ? (
                    <div><button
                      type="button"
                      className="btn btn--secondary"
                      disabled={
                        creatingQualityProject || !qualityProjectKey.trim()
                      }
                      onClick={() => void onCreateQualityProject()}
                    >
                      {creatingQualityProject
                        ? 'Creando…'
                        : 'Crear proyecto'}
                    </button></div>
                  ) : null}
                </form>

                <SeverityTrendChart snapshots={snapshots} />

                {baselineHistoryError ? <ErrorState message={baselineHistoryError} /> : null}
                {baselineRun?.run.error ? <ErrorState message={baselineRun.run.error} /> : null}

                <details className="sonar-collapsible">
                  <summary>Estado del entorno y conexión</summary>
                  <MetadataList>
                    <MetadataRow label="Servidor" mono>
                      {displayValue(qualityConfig?.baseUrl)}
                    </MetadataRow>
                    <MetadataRow label="Autenticación">
                      {qualityConfig?.authenticationConfigured
                        ? 'Credencial disponible'
                        : 'No configurada'}
                    </MetadataRow>
                    <MetadataRow label="Estado del proyecto">
                      {qualityConnection?.projectState || qualityConfig?.projectState
                        ? qualityProjectStateLabel(
                          qualityConnection?.projectState ??
                          qualityConfig?.projectState ??
                          'not_configured',
                        )
                        : '—'}
                    </MetadataRow>
                    <MetadataRow label="SonarQube">
                      {qualityConnection?.version ?? '—'}
                    </MetadataRow>
                    {qualityConnection?.project ? (
                      <MetadataRow label="Proyecto remoto">
                        {qualityConnection.project.name}{' '}
                        <span className="mono">({qualityConnection.project.key})</span>
                      </MetadataRow>
                    ) : null}
                    <MetadataRow label="Última ejecución">
                      {formatTimestamp(baselineRun?.run.finishedAt ?? snapshots[0]?.createdAt)}
                    </MetadataRow>
                    <MetadataRow label="Analizador">
                      {scannerHealth == null
                        ? '—'
                        : scannerHealth.available
                          ? `Disponible${scannerHealth.version ? ` (${scannerHealth.version})` : ''}`
                          : 'No disponible'}
                    </MetadataRow>
                    {scannerHealth?.error ? (
                      <MetadataRow label="Detalle scanner">
                        {scannerHealth.error}
                      </MetadataRow>
                    ) : null}
                    <MetadataRow label="Agente de código">
                      {agentHealth
                        ? agentHealth.available
                          ? `Disponible${agentHealth.version ? ` (${agentHealth.version})` : ''}`
                          : 'No disponible'
                        : '—'}
                    </MetadataRow>
                    <MetadataRow label="Capacidad del agente">
                      {agentHealth?.capabilities.includes('apply-fix') ? 'Aplicar correcciones' : '—'}
                    </MetadataRow>
                    <MetadataRow label="LiteLLM">
                      {llmHealth
                        ? `${llmHealth.available ? 'Disponible' : 'No disponible'}${llmHealth.model ? ` (${llmHealth.model})` : ''}`
                        : '—'}
                    </MetadataRow>
                    <MetadataRow label="Historial de capturas">{snapshots.length}</MetadataRow>
                  </MetadataList>
                </details>

                {showIssues && qualityIssues ? (
                  <div className="modal-backdrop" onMouseDown={(event) => {
                    if (event.target === event.currentTarget) setShowIssues(false);
                  }}>
                    <section className="issues-modal" role="dialog" aria-modal="true" aria-labelledby="issues-modal-title">
                      <div className="issues-modal__header">
                        <div>
                          <h2 id="issues-modal-title">Hallazgos de Sonar</h2>
                          <p>
                            {qualityIssues.issues.filter((issue) => !isResolvedIssue(issue)).length} activos ·{' '}
                            {qualityIssues.issues.filter(isResolvedIssue).length} solucionados · {selected?.name}
                          </p>
                        </div>
                        <div className="button-row">
                          <button type="button" className="btn btn--ghost" disabled={loadingIssues} onClick={() => void onOpenIssues()}>
                            <Icon name="refresh" />
                            Actualizar
                          </button>
                          <button type="button" className="btn btn--secondary" disabled={loadingIssues} onClick={() => void onDownloadIssues()}>
                            <Icon name="download" />
                            Descargar Excel
                          </button>
                           <button type="button" className="modal-close" onClick={() => setShowIssues(false)} aria-label="Cerrar hallazgos">×</button>
                        </div>
                      </div>
                      <div className="issues-modal__body">
                        <div className="issues-workspace">
                          <aside className="issues-browser" aria-label="Listado de hallazgos">
                            <div className="issue-status-filters" aria-label="Filtrar por estado">
                              {([
                                ['open', 'Activos'],
                                ['resolved', 'Solucionados'],
                                ['all', 'Todos'],
                              ] as const).map(([value, label]) => (
                                <button
                                  type="button"
                                  key={value}
                                  className={`btn btn--ghost${issueStatusFilter === value ? ' is-active' : ''}`}
                                  aria-pressed={issueStatusFilter === value}
                                  onClick={() => onFilterIssueStatus(value)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            {Object.keys(visibleSeverityCounts).length > 0 ? (
                              <div className="severity-chip-row" aria-label="Filtrar por gravedad">
                                {orderSeverityEntries(visibleSeverityCounts).map(
                                  ([sev, count]) => (
                                    <button
                                      type="button"
                                      key={sev}
                                      className={`severity-chip severity-chip--clickable severity-chip--${sev.toLowerCase()}${severityFilter === sev ? ' is-active' : ''}`}
                                      aria-pressed={severityFilter === sev}
                                      onClick={() => onFilterSeverity(sev)}
                                    >
                                      <strong>{count}</strong>
                                      {sev}
                                    </button>
                                  ),
                                )}
                              </div>
                            ) : null}
                            <p className="issues-browser__count">
                              {visibleIssues.length} de {qualityIssues.total} hallazgos
                              {` · ${issueStatusFilter === 'open' ? 'Activos' : issueStatusFilter === 'resolved' ? 'Solucionados' : 'Todos'}`}
                              {severityFilter ? ` · ${severityFilter}` : ''}
                            </p>
                            {visibleIssues.length === 0 ? (
                              <EmptyState message="No hay hallazgos para los filtros seleccionados." />
                            ) : (
                              <ul className="issue-list">
                                {visibleIssues.map((issue) => (
                              <li key={issue.id}>
                                <button
                                  type="button"
                                  className={
                                    selectedIssue?.id === issue.id
                                      ? 'issue-row is-active'
                                      : 'issue-row'
                                  }
                                  onClick={() => onSelectIssue(issue)}
                                >
                                  <span className={`issue-row__sev issue-row__sev--${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                                   {isResolvedIssue(issue) && <span className="issue-row__closed" title="Solucionado en Sonar">✓</span>}
                                  {latestProposalByIssue.has(issue.id) ? <span className="issue-row__proposal" title="Tiene propuesta vigente">✓ IA</span> : null}
                                  <span className="issue-row__rule mono">{issue.rule}</span>
                                  <span className="issue-row__loc mono">
                                    {issue.file}
                                    {issue.line != null ? `:${issue.line}` : ''}
                                  </span>
                                  <span className="issue-row__msg">{issue.message}</span>
                                </button>
                              </li>
                                ))}
                              </ul>
                            )}
                          </aside>

                          <section className="issue-detail-pane" aria-label="Detalle del hallazgo">
                            {selectedIssue ? (
                          <div className="issue-detail">
                            <h3 className="subsection-title">Detalle</h3>
                            <MetadataList>
                              <MetadataRow label="Severidad">
                                {selectedIssue.severity}
                              </MetadataRow>
                              <MetadataRow label="Regla" mono>
                                {selectedIssue.rule}
                              </MetadataRow>
                              <MetadataRow label="Archivo" mono>
                                {selectedIssue.file}
                                {selectedIssue.line != null
                                  ? `:${selectedIssue.line}`
                                  : ''}
                              </MetadataRow>
                              <MetadataRow label="Mensaje">
                                {selectedIssue.message}
                              </MetadataRow>
                              {selectedIssue.status ? (
                                <MetadataRow label="Estado">
                                  {selectedIssue.status}
                                </MetadataRow>
                              ) : null}
                              {selectedIssue.type ? (
                                <MetadataRow label="Tipo">{selectedIssue.type}</MetadataRow>
                              ) : null}
                              {selectedIssue.effort ? (
                                <MetadataRow label="Esfuerzo">
                                  {selectedIssue.effort}
                                </MetadataRow>
                              ) : null}
                            </MetadataList>
                            <div className="button-row" style={{ marginTop: 10 }}>
                              <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={downloadingIssueReport}
                                onClick={() => void onDownloadIssueReport()}
                                title="Disponible para hallazgos activos y solucionados"
                              >
                                <Icon name="report" />
                                {downloadingIssueReport ? 'Generando informe…' : 'Descargar informe'}
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={loadingIssueContext || isResolvedIssue(selectedIssue)}
                                onClick={() => void onLoadIssueContext()}
                              >
                                <Icon name="code" />
                                {loadingIssueContext
                                  ? 'Resolviendo…'
                                  : 'Ver contexto de código'}
                              </button>
                              <button
                                type="button"
                                className="btn btn--primary"
                                disabled={proposingFix || isResolvedIssue(selectedIssue) || hasActiveSelectedProposal}
                                onClick={() => void onProposeFix(false)}
                              >
                                <Icon name={hasActiveSelectedProposal ? 'check' : 'lightbulb'} />
                                {hasActiveSelectedProposal ? 'Propuesta disponible' : proposalExecutionMode === 'default' ? 'Analizando…' : 'Proponer corrección'}
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={proposingFix || isResolvedIssue(selectedIssue) || llmHealth?.available === false || hasActiveSelectedProposal}
                                onClick={() => void onProposeFix(true)}
                                title="Ignora la remediación local registrada y solicita una propuesta a la IA"
                              >
                                <Icon name="sparkles" />
                                {hasActiveSelectedProposal ? 'Propuesta disponible' : proposalExecutionMode === 'ai' ? 'Consultando IA…' : 'Proponer con IA'}
                              </button>
                            </div>
                            {proposingFix ? (
                              <LoadingState
                                label={`${runningStepLabel(lastEvent)} — modo solo lectura`}
                              />
                            ) : null}
                            {proposalRun?.steps.length ? (
                              <ul className="step-list" style={{ marginTop: 12 }}>
                                {proposalRun.steps.map((step) => (
                                  <li key={step.id} className="step-row">
                                    <StatusBadge status={step.status} />
                                    <span>{baselineStepLabel(step.stepId)}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {proposalError ? <ErrorState message={proposalError} /> : null}
                            {agentProposal ? (
                              <div className="subsection">
                                <h3 className="subsection-title">Propuesta de remediación</h3>
                                <p><strong>Solo propuesta: no se modificaron archivos</strong></p>
                                <MetadataList>
                                  <MetadataRow label="Resumen">{agentProposal.summary}</MetadataRow>
                                  <MetadataRow label="Diagnóstico">{agentProposal.diagnosis ?? '—'}</MetadataRow>
                                  <MetadataRow label="Riesgo">{agentProposal.agentSuggestedRisk}</MetadataRow>
                                  <MetadataRow label="Estrategia de remediación">
                                    {(agentProposal.remediationStrategy ?? 'manual').toUpperCase()}
                                  </MetadataRow>
                                  <MetadataRow label="Motivo">{agentProposal.remediationReason ?? '—'}</MetadataRow>
                                  <MetadataRow label="Tokens de contexto estimados">
                                    {agentProposal.estimatedInputTokens ?? 0}
                                  </MetadataRow>
                                  {agentProposal.inputTokens != null ? (
                                    <MetadataRow label="Tokens de entrada reales">{agentProposal.inputTokens}</MetadataRow>
                                  ) : null}
                                  {agentProposal.outputTokens != null ? (
                                    <MetadataRow label="Tokens de salida reales">{agentProposal.outputTokens}</MetadataRow>
                                  ) : null}
                                  <MetadataRow label="Repositorio sin cambios">
                                    {agentProposal.repositoryUnchanged ? 'Sí' : 'No'}
                                  </MetadataRow>
                                  <MetadataRow label="Creada">{formatTimestamp(agentProposal.createdAt)}</MetadataRow>
                                </MetadataList>
                                {agentProposal.executionTrace ? (
                                  <>
                                    <h4>Trazabilidad de entrada de IA</h4>
                                    <p className="text-muted">
                                      Evidencia local del contexto indexado y del prompt sanitizado enviado al proveedor de razonamiento.
                                    </p>
                                    <MetadataList>
                                      <MetadataRow label="Proveedor del índice">
                                        {agentProposal.executionTrace.indexProvider ?? '—'}
                                      </MetadataRow>
                                      <MetadataRow label="Estado del índice">
                                        {agentProposal.executionTrace.indexState ?? '—'}
                                      </MetadataRow>
                                      <MetadataRow label="Símbolo objetivo">
                                        {agentProposal.executionTrace.targetSymbol ?? '—'}
                                      </MetadataRow>
                                      <MetadataRow label="Contexto indexado">
                                        {agentProposal.executionTrace.filesIncluded.length} archivo(s),{' '}
                                        {agentProposal.executionTrace.symbolsIncluded} símbolo(s),{' '}
                                        {agentProposal.executionTrace.snippetsIncluded} fragmento(s)
                                      </MetadataRow>
                                      <MetadataRow label="Caracteres de fragmentos">
                                        {agentProposal.executionTrace.snippetChars.toLocaleString()}
                                      </MetadataRow>
                                      <MetadataRow label="Caracteres del prompt">
                                        {agentProposal.executionTrace.promptChars.toLocaleString()}
                                      </MetadataRow>
                                      <MetadataRow label="Prompt SHA-256">
                                        <span className="mono">{agentProposal.executionTrace.promptSha256}</span>
                                      </MetadataRow>
                                    </MetadataList>
                                    {agentProposal.executionTrace.filesIncluded.length ? (
                                      <div className="compact-proposal-section">
                                        <h4>Contexto enviado a la IA</h4>
                                        <div className="compact-file-list">
                                          {agentProposal.executionTrace.filesIncluded.map((file) => (
                                            <code key={file}>{file}</code>
                                          ))}
                                        </div>
                                      </div>
                                    ) : null}
                                  </>
                                ) : null}
                                <div className="compact-proposal-section">
                                  <h4>Archivos afectados</h4>
                                  <div className="compact-file-list">
                                    {agentProposal.affectedFiles.map((file) => <code key={file}>{file}</code>)}
                                  </div>
                                </div>
                                <div className="compact-proposal-section">
                                  <h4>Cambios propuestos</h4>
                                  <div className="compact-change-list">
                                  {agentProposal.proposedChanges.map((change, index) => (
                                      <div key={`${change.file}-${index}`}>
                                        <code>{change.file}</code>
                                        <span>{change.description}</span>
                                        {change.rationale ? <small>{change.rationale}</small> : null}
                                      </div>
                                  ))}
                                  </div>
                                </div>
                                {agentProposal.patch ? (
                                  <>
                                    <h4>Parche determinista</h4>
                                    <p className="text-muted">
                                      El platform aplicará estas ediciones exactas después de la aprobación. Las precondiciones se vuelven a verificar contra el archivo actual.
                                    </p>
                                    <ul>
                                      {agentProposal.patch.edits.map((edit, index) => (
                                        <li key={`${edit.file}-${edit.startLine}-${index}`}>
                                          <span className="mono">{edit.file}:{edit.startLine}</span>
                                          <DiffPreview removed={edit.expectedText} added={edit.replacement} />
                                        </li>
                                      ))}
                                    </ul>
                                    {agentProposal.patch.preconditions.length ? (
                                      <details>
                                        <summary>Ver precondiciones de seguridad</summary>
                                        <ul>
                                          {agentProposal.patch.preconditions.map((precondition) => (
                                            <li key={precondition.file}>
                                              <span className="mono">{precondition.file}</span>: no debe coincidir con{' '}
                                              {precondition.forbiddenPatterns.join(', ')}
                                            </li>
                                          ))}
                                        </ul>
                                      </details>
                                    ) : null}
                                  </>
                                ) : null}
                                <div className="compact-proposal-section">
                                  <h4>Plan de validación</h4>
                                  <div className="validation-flow">
                                    {agentProposal.validationPlan.map((item, index) => (
                                      <span className="validation-step" key={index}><code>{item}</code></span>
                                    ))}
                                  </div>
                                </div>
                                {!agentProposal.contextRevision ? (
                                  <p className="text-muted">Esta propuesta fue creada sin hashes de contexto. Genera una nueva propuesta antes de aplicar.</p>
                                ) : null}
                                <div className="button-row" style={{ marginTop: 12 }}>
                                  <button
                                    type="button"
                                    className="btn btn--secondary"
                                    disabled={applyingFix || agentProposal.status === 'rejected' || isResolvedIssue(selectedIssue)}
                                    onClick={() => void onRejectFix()}
                                  >
                                    <Icon name="reject" />
                                    Rechazar
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--primary"
                                    disabled={applyingFix || !canApplyNormally || isResolvedIssue(selectedIssue)}
                                    onClick={() => void onApplyFix(false)}
                                    title={applyUnavailableReason ?? undefined}
                                  >
                                    <Icon name={agentProposal.requiresAgent ? 'robot' : 'play'} />
                                    {applyExecutionMode === 'default'
                                      ? 'Aplicando y validando…'
                                      : agentProposal.requiresAgent
                                        ? 'Aplicar con agente'
                                        : agentProposal.remediationStrategy === 'local'
                                          ? agentProposal.patch ? 'Aplicar parche local' : 'Aplicación local no disponible'
                                          : 'Aplicar parche propuesto'}
                                  </button>
                                  {!agentProposal.requiresAgent ? (
                                    <button
                                      type="button"
                                      className="btn btn--secondary"
                                      disabled={applyingFix || !proposalReady || !agentCanApply || isResolvedIssue(selectedIssue)}
                                      onClick={() => void onApplyFix(true)}
                                      title={!proposalReady
                                        ? (applyUnavailableReason ?? 'La propuesta no está lista para aplicar')
                                        : !agentCanApply
                                          ? (agentHealth?.error ?? 'El agente de código no está disponible')
                                          : 'Delega la aplicación al agente de IA aunque exista una estrategia local'}
                                    >
                                      <Icon name="robot" />
                                      {applyExecutionMode === 'ai' ? 'Aplicando con IA…' : 'Aplicar con IA'}
                                    </button>
                                  ) : null}
                                </div>
                                {applyUnavailableReason ? (
                                  <p className="text-muted" role="status">{applyUnavailableReason}</p>
                                ) : null}
                                {fixApplicationRun?.steps.length ? (
                                  <>
                                    <h4>Aplicación de corrección de calidad</h4>
                                    <ul className="step-list">
                                      {fixApplicationRun.steps.map((step) => (
                                        <li key={step.id} className="step-row">
                                          <StatusBadge status={step.status} />
                                          <span>{baselineStepLabel(step.stepId)}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                ) : null}
                                {fixApplication ? (
                                  <div className="subsection">
                                    <h4>{fixApplication.status === 'completed' ? 'CORRECCIÓN APLICADA' : fixApplication.status.toUpperCase().replace(/_/g, ' ')}</h4>
                                    <MetadataList>
                                      <MetadataRow label="Aprobada por">{fixApplication.approvedBy}</MetadataRow>
                                      <MetadataRow label="Aprobada el">{formatTimestamp(fixApplication.approvedAt)}</MetadataRow>
                                      <MetadataRow label="Archivos modificados">{fixApplication.data.changes?.changedFiles?.length ?? 0}</MetadataRow>
                                      <MetadataRow label="Líneas agregadas">{fixApplication.data.changes?.linesAdded ?? 0}</MetadataRow>
                                      <MetadataRow label="Líneas eliminadas">{fixApplication.data.changes?.linesRemoved ?? 0}</MetadataRow>
                                      <MetadataRow label="Hallazgo objetivo">
                                        {fixApplication.data.quality?.targetResolved === true ? 'RESUELTO' : fixApplication.data.quality?.targetResolved === false ? 'SIN CAMBIOS' : '—'}
                                      </MetadataRow>
                                      <MetadataRow label="Total de calidad">
                                        {fixApplication.data.quality?.before && fixApplication.data.quality?.after
                                          ? `${fixApplication.data.quality.before.totalIssues} → ${fixApplication.data.quality.after.totalIssues}`
                                          : '—'}
                                      </MetadataRow>
                                      <MetadataRow label="Reversión">
                                        {fixApplication.data.rollback
                                          ? fixApplication.data.rollback.verified ? 'EXITOSA' : 'FALLIDA'
                                          : 'No requerida'}
                                      </MetadataRow>
                                      <MetadataRow label="Repositorio">
                                        {fixApplication.data.repository?.state ?? (fixApplication.status === 'rolled_back' ? 'restored' : '—')}
                                      </MetadataRow>
                                    </MetadataList>
                                    {fixApplication.data.validations ? (
                                      <>
                                        <h4>Validación</h4>
                                        <div className="validation-badges">
                                          {Object.entries(fixApplication.data.validations).map(([kind, result]) => {
                                            const status = (result.status ?? '').trim().toLowerCase();
                                            const tone = status === 'passed' || status === 'ok' ? 'success' : status === 'skipped' ? 'skipped' : status === 'failed' || status === 'error' ? 'failed' : status === 'warning' ? 'warning' : 'neutral';
                                            return (
                                              <span key={kind} className={`validation-badge validation-badge--${tone}`}>
                                                <StatusBadge status={status} label={kind} />
                                                {result.summary ? <span className="mono" style={{fontSize: 10}}>{result.summary.slice(0, 60)}</span> : null}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      </>
                                    ) : null}
                                    {fixApplication.data.changes?.diff ? (
                                      <details>
                                        <summary>Revisar diferencias controladas</summary>
                                        <CodeBlock>{fixApplication.data.changes.diff}</CodeBlock>
                                      </details>
                                    ) : null}
                                    {fixApplication.data.quality?.newIssues?.length ? (
                                      <p><strong>NUEVOS HALLAZGOS INTRODUCIDOS:</strong> {fixApplication.data.quality.newIssues.length}. Se requiere revisión humana.</p>
                                    ) : null}
                                  </div>
                                ) : null}
                                {agentProposal.assumptions?.length ? (
                                  <>
                                    <h4>Supuestos</h4>
                                    <ul>{agentProposal.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
                                  </>
                                ) : null}
                                {agentProposal.warnings?.length ? (
                                  <>
                                    <h4>Advertencias</h4>
                                    <div className="warnings-compact">
                                    {agentProposal.warnings.map((item, index) => (
                                      <div key={index} className="warning-compact-item">{item}</div>
                                    ))}
                                  </div>
                                  </>
                                ) : null}
                                {agentProposal.executionTrace ? (
                                  <details className="prompt-audit-details">
                                    <summary>Ver prompt sanitizado enviado al LLM</summary>
                                    <p className="text-muted">
                                      Carga exacta retenida después de redactar secretos.
                                    </p>
                                    <PromptViewer
                                      prompt={agentProposal.executionTrace.promptPreview}
                                      truncated={agentProposal.executionTrace.promptPreviewTruncated}
                                    />
                                  </details>
                                ) : null}
                              </div>
                            ) : null}
                            {issueContext?.warnings.map((w) => (
                              <p key={w} className="text-muted">
                                {w}
                              </p>
                            ))}
                            {issueContext?.indexState === 'stale' ? (
                              <div className="button-row" style={{ marginTop: 8 }}>
                                <button
                                  type="button"
                                  className="btn btn--secondary"
                                  disabled={indexing}
                                  onClick={() => void onIndexProject(true)}
                                >
                                  Reindexar
                                </button>
                              </div>
                            ) : null}
                          </div>
                            ) : (
                              <EmptyState message="Selecciona un hallazgo para revisar el detalle." />
                            )}
                          </section>
                        </div>
                      </div>
                    </section>
                  </div>
                ) : null}

                {showBulkProposals ? (
                  <div className="modal-backdrop" onMouseDown={(event) => {
                    if (event.target === event.currentTarget && !bulkProposing) setShowBulkProposals(false);
                  }}>
                    <section className="issues-modal bulk-proposal-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-proposal-title">
                      <div className="issues-modal__header">
                        <div>
                          <h2 id="bulk-proposal-title">Propuestas agrupadas con IA</h2>
                          <p>Solo los hallazgos pendientes están seleccionados. Los que ya tienen una propuesta vigente no vuelven a consumir tokens.</p>
                        </div>
                        <button type="button" className="modal-close" disabled={bulkProposing} onClick={() => setShowBulkProposals(false)} aria-label="Cerrar propuestas agrupadas">×</button>
                      </div>
                      <div className="bulk-proposal-layout">
                        <aside className="bulk-selection-pane">
                          <div className="bulk-selection-toolbar">
                            <div>
                              <strong>{bulkSelectedIds.size}</strong> de {bulkPendingIssues.length} pendientes seleccionados
                              <small>{bulkAvailableProposals.length} con propuesta · {(qualityIssues?.issues.length ?? 0) - bulkOpenIssues.length} solucionados</small>
                            </div>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={bulkProposing || bulkPendingIssues.length === 0}
                              onClick={() => setBulkSelectedIds(
                                bulkSelectedIds.size === bulkPendingIssues.length
                                  ? new Set()
                                  : new Set(bulkPendingIssues.map((issue) => issue.id)),
                              )}
                            >
                              {bulkSelectedIds.size === bulkPendingIssues.length ? 'Deseleccionar pendientes' : 'Seleccionar pendientes'}
                            </button>
                          </div>
                          {bulkOpenIssues.length ? (
                            <ul className="bulk-issue-list">
                              {bulkOpenIssues.map((issue) => {
                                const existingProposal = latestProposalByIssue.get(issue.id);
                                return (
                                <li key={issue.id}>
                                  <label className={`${bulkSelectedIds.has(issue.id) ? 'bulk-issue-option is-selected' : 'bulk-issue-option'}${existingProposal ? ' has-proposal' : ''}`}>
                                    <input
                                      type="checkbox"
                                      checked={bulkSelectedIds.has(issue.id)}
                                      disabled={bulkProposing || Boolean(existingProposal)}
                                      onChange={() => onToggleBulkIssue(issue.id)}
                                    />
                                    <span>
                                      <strong>{issue.severity} · {issue.rule} {existingProposal ? <span className="proposal-check">✓ Propuesta</span> : null}</strong>
                                      <code>{issue.file}{issue.line != null ? `:${issue.line}` : ''}</code>
                                      <small>{issue.message}</small>
                                    </span>
                                  </label>
                                </li>
                                );
                              })}
                            </ul>
                          ) : <EmptyState message="El último reporte no contiene hallazgos activos para proponer." />}
                          <div className="bulk-selection-action">
                            <button type="button" className="btn btn--primary" disabled={bulkProposing || bulkSelectedIds.size === 0} onClick={() => void onProposeBulkFixes()}>
                              <Icon name="sparkles" />
                              {bulkProposing ? 'Preparando contexto y consultando IA…' : `Proponer para ${bulkSelectedIds.size} hallazgo${bulkSelectedIds.size === 1 ? '' : 's'}`}
                            </button>
                            <small>No se modifica código. Las propuestas quedan disponibles para revisión individual.</small>
                          </div>
                        </aside>
                        <section className="bulk-results-pane" aria-label="Resultado y prompts enviados">
                          {bulkProposing ? <LoadingState label="Resolviendo índice, agrupando contexto y generando propuestas…" /> : null}
                          {bulkProposalError ? <ErrorState message={bulkProposalError} /> : null}
                          {bulkAvailableProposals.length ? (
                            <div className="existing-proposals">
                              <div className="bulk-apply-header">
                                <div>
                                  <h3>Propuestas disponibles</h3>
                                  <small>{bulkApplySelectedIds.size} seleccionada(s) para una ejecución del agente</small>
                                </div>
                                <button type="button" className="btn btn--primary"
                                  disabled={bulkApplying || bulkApplySelectedIds.size === 0 || !agentCanApply}
                                  onClick={() => void onApplyBulkProposals()}
                                  title={!agentCanApply ? (agentHealth?.error ?? 'El agente no está disponible') : 'Una llamada al agente y una validación completa'}>
                                  <Icon name="robot" />
                                  {bulkApplying ? 'Aplicando lote…' : 'Aplicar seleccionadas'}
                                </button>
                              </div>
                              {bulkAvailableProposals.map((proposal) => {
                                const issue = qualityIssues?.issues.find((item) => item.id === proposal.issueId);
                                return (
                                  <article className="existing-proposal-card" key={proposal.id}>
                                    <input type="checkbox" checked={bulkApplySelectedIds.has(proposal.id)}
                                      disabled={bulkApplying}
                                      aria-label={`Seleccionar propuesta ${issue?.rule ?? proposal.issueId}`}
                                      onChange={() => setBulkApplySelectedIds((current) => {
                                        const next = new Set(current);
                                        if (next.has(proposal.id)) next.delete(proposal.id); else next.add(proposal.id);
                                        return next;
                                      })} />
                                    <div>
                                      <strong>{issue?.rule ?? proposal.issueId}</strong>
                                      <small>{proposal.summary}</small>
                                      <code>{issue?.file ?? proposal.affectedFiles[0] ?? '—'}</code>
                                    </div>
                                    <button type="button" className="btn btn--secondary" onClick={() => void onReviewExistingProposal(proposal)}>
                                      Revisar y aplicar
                                    </button>
                                  </article>
                                );
                              })}
                            </div>
                          ) : null}
                          {bulkApplyRun?.steps.length ? (
                            <div className="bulk-apply-progress">
                              <h3>Aplicación masiva</h3>
                              <ul className="step-list">
                                {bulkApplyRun.steps.map((step) => (
                                  <li key={step.id} className="step-row">
                                    <StatusBadge status={step.status} />
                                    <span>{baselineStepLabel(step.stepId)}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {bulkProposalResult ? (
                            <div className="bulk-results">
                              <div className="bulk-result-summary">
                                <span><strong>{bulkProposalResult.proposed}</strong> propuestas</span>
                                <span><strong>{bulkProposalResult.reused?.length ?? 0}</strong> reutilizadas</span>
                                <span><strong>{bulkProposalResult.groups.length}</strong> grupos</span>
                                <span><strong>{bulkProposalResult.skipped.length}</strong> omitidos</span>
                              </div>
                              {bulkProposalResult.skipped.length ? (
                                <details>
                                  <summary>Ver hallazgos omitidos</summary>
                                  <ul>{bulkProposalResult.skipped.map((item) => <li key={item.issueId}><code>{item.issueId}</code>: {item.reason}</li>)}</ul>
                                </details>
                              ) : null}
                              {bulkProposalResult.reused?.length ? (
                                <details>
                                  <summary>Ver propuestas reutilizadas</summary>
                                  <ul>{bulkProposalResult.reused.map((item) => <li key={item.issueId}><code>{item.issueId}</code>: {item.reason}</li>)}</ul>
                                </details>
                              ) : null}
                              {bulkProposalResult.groups.map((group) => (
                                <article className={`bulk-group-card bulk-group-card--${group.status}`} key={group.id}>
                                  <div className="bulk-group-card__header">
                                    <div>
                                      <strong>{group.rule}</strong>
                                      <code>{group.file}</code>
                                    </div>
                                    <StatusBadge status={group.status} />
                                  </div>
                                  <p>
                                    {group.issueIds.length} hallazgo(s) · entrada: {group.estimatedInputTokens.toLocaleString()} estimados
                                    {group.inputTokens != null ? ` / ${group.inputTokens.toLocaleString()} reales` : ''}
                                    {' · '}salida: {group.estimatedOutputTokens.toLocaleString()} estimados
                                    {group.outputTokens != null ? ` / ${group.outputTokens.toLocaleString()} reales` : ''}
                                  </p>
                                  {group.splitFrom ? <p>Subgrupo creado automáticamente desde <strong>{group.splitFrom}</strong>.</p> : null}
                                  {group.attempts && group.attempts > 1 ? <p>La respuesta se reparó en un segundo intento compacto, sin reenviar el contexto completo.</p> : null}
                                  {group.error ? <ErrorState message={group.error} /> : null}
                                  <details className="prompt-audit-details">
                                    <summary>Ver prompt completo enviado a la IA</summary>
                                    <p className="text-muted">Prompt sanitizado exacto · {group.promptChars.toLocaleString()} caracteres · modelo {group.model ?? '—'}</p>
                                    <PromptViewer prompt={group.prompt} />
                                  </details>
                                  {group.recoveryPrompt ? (
                                    <details className="prompt-audit-details">
                                      <summary>Ver prompt compacto de reparación</summary>
                                      <PromptViewer prompt={group.recoveryPrompt} />
                                    </details>
                                  ) : null}
                                </article>
                              ))}
                            </div>
                          ) : !bulkProposing && !bulkProposalError && bulkAvailableProposals.length === 0 ? (
                            <EmptyState message="Selecciona los hallazgos y genera las propuestas. Aquí podrás revisar todos los prompts exactos enviados a la IA." />
                          ) : null}
                        </section>
                      </div>
                    </section>
                  </div>
                ) : null}

                {loadingIssues ? <LoadingState label="Cargando hallazgos…" /> : null}
                {qualityError ? <ErrorState message={qualityError} /> : null}
              </Section>

              <Section
                id="indice"
                title="Índice de código"
                description="Estado del índice y acciones de indexación."
                actions={
                  <div className="button-row">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={indexing || !selectedId}
                      onClick={() => void onIndexProject(false)}
                    >
                      {indexing ? 'Indexando…' : 'Indexar proyecto'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={indexing || !selectedId}
                      onClick={() => void onIndexProject(true)}
                    >
                      Reindexar
                    </button>
                    <a
                      className="btn btn--secondary"
                      href={graphUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir grafo
                    </a>
                  </div>
                }
              >
                {indexing ? <LoadingState label="Indexando proyecto…" /> : null}

                <p className="text-muted mono" title="URL del grafo en Codebase Memory">
                  {graphUrl}
                </p>

                <MetadataList>
                  <MetadataRow label="Estado">
                    {indexStatus ? (
                      <StatusBadge status={indexStatus.state} />
                    ) : (
                      '—'
                    )}
                  </MetadataRow>
                  <MetadataRow label="Proveedor">
                    {displayValue(indexerHealth?.provider ?? indexStatus?.provider)}
                  </MetadataRow>
                  <MetadataRow label="CLI">
                    {indexerHealth ? (
                      <StatusBadge
                        status={cliAvailable ? 'available' : 'unavailable'}
                        label={
                          cliAvailable
                            ? indexerHealth.version
                              ? `disponible (${indexerHealth.version})`
                              : 'disponible'
                            : 'no disponible'
                        }
                      />
                    ) : (
                      '—'
                    )}
                  </MetadataRow>
                  <MetadataRow label="Graph UI">
                    {indexerHealth ? (
                      <StatusBadge
                        status={uiAvailable ? 'available' : 'unavailable'}
                        label={uiAvailable ? 'disponible' : 'no disponible'}
                      />
                    ) : (
                      '—'
                    )}
                  </MetadataRow>
                  <MetadataRow label="Última indexación">
                    {formatTimestamp(indexStatus?.indexedAt)}
                  </MetadataRow>
                  <MetadataRow label="Revisión indexada" mono>
                    {shortSha(indexStatus?.indexedRevision)}
                  </MetadataRow>
                  <MetadataRow label="Revisión actual" mono>
                    {shortSha(indexStatus?.currentRevision)}
                  </MetadataRow>
                  <MetadataRow label="Working tree">
                    {indexStatus?.workingTreeClean === undefined
                      ? '—'
                      : indexStatus.workingTreeClean
                        ? 'limpio'
                        : 'con cambios'}
                  </MetadataRow>
                  {indexStatus?.providerProjectName ? (
                    <MetadataRow label="Nombre en provider" mono>
                      {indexStatus.providerProjectName}
                    </MetadataRow>
                  ) : null}
                </MetadataList>

                {indexStatus?.error ? (
                  <ErrorState message="Error de indexación" details={indexStatus.error} />
                ) : null}
                {indexError ? <ErrorState message={indexError} /> : null}
                {indexerHealth?.error && !indexerHealth.cliAvailable ? (
                  <p className="text-muted">CLI: {indexerHealth.error}</p>
                ) : null}
              </Section>

              <Section
                id="contexto"
                title="Explorador de contexto"
                description="Busca un símbolo en el índice del proyecto."
              >
                <form className="form-stack" onSubmit={(e) => void onSearchContext(e)}>
                  <div className="field">
                    <label className="field__label" htmlFor="symbol-query">
                      Símbolo
                    </label>
                    <input
                      id="symbol-query"
                      className="input input--mono"
                      type="text"
                      value={symbolQuery}
                      onChange={(e) => setSymbolQuery(e.target.value)}
                      placeholder="p. ej. LoadProjectStep"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={searchingContext || !symbolQuery.trim()}
                    >
                      {searchingContext ? 'Buscando…' : 'Buscar'}
                    </button>
                    {searchingContext ? <LoadingState label="Buscando símbolo…" /> : null}
                  </div>
                </form>

                {contextError ? <ErrorState message={contextError} /> : null}

                {contextResult ? (
                  <div className="context-panel">
                    <div className="context-block">
                      <h3 className="context-block__title">Símbolo</h3>
                      {contextResult.target ? (
                        <MetadataList>
                          <MetadataRow label="Nombre" mono>
                            {contextResult.target.name}
                          </MetadataRow>
                          <MetadataRow label="Archivo" mono>
                            {displayValue(contextResult.target.filePath)}
                          </MetadataRow>
                          <MetadataRow label="Tipo">
                            {displayValue(contextResult.target.kind)}
                          </MetadataRow>
                          <MetadataRow label="Líneas">
                            {contextResult.target.startLine != null
                              ? `${contextResult.target.startLine}${contextResult.target.endLine != null
                                ? `–${contextResult.target.endLine}`
                                : ''
                              }`
                              : '—'}
                          </MetadataRow>
                        </MetadataList>
                      ) : (
                        <p className="context-empty">Sin coincidencias para ese símbolo.</p>
                      )}
                      {contextResult.symbols.length > 1 ? (
                        <p className="text-muted">
                          {contextResult.symbols.length} homónimos (lista acotada).
                        </p>
                      ) : null}
                    </div>

                    <div className="context-block">
                      <h3 className="context-block__title">Callers</h3>
                      {callers.length > 0 ? (
                        <ul className="context-list">
                          {callers.map((name) => (
                            <li key={`caller-${name}`}>{name}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="context-empty">No hay callers relacionados.</p>
                      )}
                    </div>

                    <div className="context-block">
                      <h3 className="context-block__title">Callees</h3>
                      {callees.length > 0 ? (
                        <ul className="context-list">
                          {callees.map((name) => (
                            <li key={`callee-${name}`}>{name}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="context-empty">No hay callees relacionados.</p>
                      )}
                    </div>

                    <div className="context-block">
                      <h3 className="context-block__title">Dependencias</h3>
                      {dependencies.length > 0 ? (
                        <ul className="context-list">
                          {dependencies.map((dep) => (
                            <li key={`dep-${dep}`}>{dep}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="context-empty">No hay dependencias relacionadas.</p>
                      )}
                    </div>

                    <div className="context-block">
                      <h3 className="context-block__title">Tests</h3>
                      {contextResult.tests.length > 0 ? (
                        <ul className="context-list">
                          {contextResult.tests.map((t) => (
                            <li key={`test-${t.name}`}>{t.name}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="context-empty">No hay tests relacionados.</p>
                      )}
                    </div>

                    <div className="context-block">
                      <h3 className="context-block__title">Snippets</h3>
                      {contextResult.snippets.length > 0 ? (
                        contextResult.snippets.map((snip, i) => (
                          <CodeBlock key={`${snip.filePath ?? 'snip'}-${i}`}>
                            {snip.content}
                          </CodeBlock>
                        ))
                      ) : (
                        <p className="context-empty">No hay snippets disponibles.</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </Section>
            </>
          ) : null}

          {!selected && overviewError ? (
            <Section id="resumen" title="Resumen del proyecto">
              <ErrorState message={overviewError} />
            </Section>
          ) : null}

          {!selected && !overviewError ? (
            <Section
              id="resumen"
              title="Resumen del proyecto"
              description="Abre un proyecto para ver perfil, comandos e índice."
            >
              <EmptyState
                message="Selecciona un proyecto de la lista o registra uno nuevo."
                action={<button type="button" className="btn btn--primary" onClick={() => onNavClick('proyectos')}>Ir a proyectos</button>}
              />
            </Section>
          ) : null}

          {!selected ? (
            <>
              <Section
                id="calidad"
                title="Calidad"
                description="Disponible al abrir un proyecto."
              >
                <EmptyState
                  message="Abre un proyecto para configurar el proveedor de calidad."
                  action={<button type="button" className="btn btn--primary" onClick={() => onNavClick('proyectos')}>Seleccionar proyecto</button>}
                />
              </Section>
              <Section
                id="indice"
                title="Índice de código"
                description="Disponible al abrir un proyecto."
              >
                <EmptyState
                  message="Abre un proyecto para ver el estado del índice."
                  action={<button type="button" className="btn btn--primary" onClick={() => onNavClick('proyectos')}>Seleccionar proyecto</button>}
                />
              </Section>
              <Section
                id="contexto"
                title="Explorador de contexto"
                description="Disponible al abrir un proyecto."
              >
                <EmptyState
                  message="Abre un proyecto para buscar símbolos en el índice."
                  action={<button type="button" className="btn btn--primary" onClick={() => onNavClick('proyectos')}>Seleccionar proyecto</button>}
                />
              </Section>
            </>
          ) : null}

          <Section
            id="pipelines"
            title="Pipelines"
            description="El navegador no ejecuta procesos. Solo solicita un run al agent local."
          >
            {pipelinesError ? <ErrorState message={pipelinesError} /> : null}

            {pipelines.length === 0 ? (
              <EmptyState message="No hay pipelines registrados." />
            ) : (
              <ul className="pipeline-list">
                {pipelines.map((pipe) => (
                  <li key={pipe.id}>
                    <button
                      type="button"
                      className={
                        pipe.id === selectedPipelineId
                          ? 'pipeline-item is-active'
                          : 'pipeline-item'
                      }
                      onClick={() => setSelectedPipelineId(pipe.id)}
                    >
                      <span className="pipeline-item__name">{pipe.name}</span>
                      <span className="pipeline-item__desc">{pipe.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="button-row" style={{ margin: '10px 0' }} >
              <button
                type="button"
                className="btn btn--primary"
                disabled={!selectedId || !selectedPipelineId || runningPipeline}
                onClick={() => void onRunPipeline()}
              >
                {runningPipeline ? 'Ejecutando…' : 'Ejecutar pipeline'}
              </button>
              {runningPipeline ? <LoadingState label="Ejecutando pipeline…" /> : null}
            </div>

            {!selectedId ? (
              <div style={{ margin: '10px 0' }} >
                <p className="text-muted">
                  Selecciona un proyecto para ejecutar el pipeline.
                </p>
              </div>

            ) : null}

            {pipelineError ? <ErrorState message={pipelineError} /> : null}

            {pipelineRun ? (
              <div className="run-summary">
                <span className="run-summary__label">Resultado</span>
                <StatusBadge status={pipelineRun.run.status} />
                {formatDuration(pipelineRun.run.durationMs) ? (
                  <span className="step-flow__duration">
                    {formatDuration(pipelineRun.run.durationMs)}
                  </span>
                ) : null}
                {pipelineRun.run.error ? (
                  <ErrorState
                    message="El pipeline terminó con error"
                    details={pipelineRun.run.error}
                  />
                ) : null}
              </div>
            ) : null}

            {displaySteps.length > 0 ? (
              <ol className="step-flow">
                {displaySteps.map((step, index) => (
                  <li
                    key={`${step.stepId}-${step.stepOrder}`}
                    className={[
                      'step-flow__item',
                      step.status === 'running' ? 'is-running' : null,
                      step.status === 'failed' ? 'is-failed' : null,
                      step.status === 'success' ? 'is-success' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className="step-flow__index">{index + 1}</span>
                    <span className="step-flow__name">{step.name}</span>
                    <div className="step-flow__meta">
                      {formatDuration(step.durationMs) ? (
                        <span className="step-flow__duration">
                          {formatDuration(step.durationMs)}
                        </span>
                      ) : null}
                      <StatusBadge status={step.status} />
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </Section>

          <Section
            id="sistema"
            title="Sistema"
            description="Estado del agent local y del canal en tiempo real."
          >
            <div className="subsection">
              <h3 className="subsection-title">Backend (REST)</h3>
              <MetadataList>
                <MetadataRow label="Estado">
                  <StatusBadge
                    status={healthBadgeStatus}
                    label={
                      healthState === 'ok' ? health?.status ?? 'ok' : healthState
                    }
                  />
                </MetadataRow>
                {health ? (
                  <>
                    <MetadataRow label="Servicio">{health.service}</MetadataRow>
                    <MetadataRow label="Fase">{String(health.phase)}</MetadataRow>
                    <MetadataRow label="SQLite">
                      {health.sqlite.ready ? 'listo' : 'no listo'}
                    </MetadataRow>
                    <MetadataRow label="Timestamp" mono>
                      {health.timestamp}
                    </MetadataRow>
                  </>
                ) : null}
              </MetadataList>
              {healthError ? <ErrorState message={healthError} /> : null}
              <div className="button-row" style={{ margin: '10px 0' }}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => void refreshHealth()}
                >
                  Reintentar health
                </button>
              </div>
            </div>

            <div className="subsection">
              <h3 className="subsection-title">WebSocket</h3>
              <MetadataList>
                <MetadataRow label="Estado">
                  <StatusBadge status={wsStatus} />
                </MetadataRow>
                <MetadataRow label="Último evento">
                  {lastEvent ? (
                    <>
                      <span className="mono">{lastEvent.type}</span>
                      <span className="text-muted"> — {lastEvent.summary}</span>
                    </>
                  ) : (
                    <>
                      Esperando evento <span className="mono">connection.hello</span>…
                    </>
                  )}
                </MetadataRow>
              </MetadataList>
            </div>
          </Section>

          <footer className="app-footer">
            <p>
              La UI no accede al filesystem. Todo acceso local va por NestJS (
              <code>local-agent</code>). El grafo vive en Codebase Memory, no en SQLite.
            </p>
          </footer>
        </div>
      </main>
    </div>
  );
}
