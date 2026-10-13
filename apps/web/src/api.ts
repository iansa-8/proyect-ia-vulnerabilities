import { API_BASE_URL } from './config';

export interface HealthResponse {
  status: string;
  service: string;
  phase: number;
  timestamp: string;
  sqlite: {
    ready: boolean;
    path: string;
  };
}

export interface ProjectProfile {
  runtime?: string;
  framework?: string;
  packageManager?: string;
  buildCommand?: string;
  testCommand?: string;
  coverageCommand?: string;
  e2eCommand?: string;
  startCommand?: string;
  hasDocker: boolean;
  hasSonar: boolean;
}

export interface ProjectCommandOverrides {
  buildCommand?: string;
  testCommand?: string;
  coverageCommand?: string;
  e2eCommand?: string;
  startCommand?: string;
}

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  profile?: ProjectProfile;
  commandOverrides?: ProjectCommandOverrides;
  effectiveProfile: ProjectProfile;
  createdAt: string;
  updatedAt: string;
}

export interface IndexerHealthResponse {
  provider: string;
  cliAvailable: boolean;
  uiAvailable: boolean;
  version?: string;
  error?: string;
}

export interface ProjectIndexStatusView {
  projectId: string;
  provider: string;
  state: string;
  providerProjectName?: string;
  indexedAt?: string;
  durationMs?: number;
  indexedRevision?: string;
  currentRevision?: string;
  workingTreeClean?: boolean;
  filesCount?: number;
  symbolsCount?: number;
  relationshipsCount?: number;
  error?: string;
}

export interface CodeSymbolView {
  name: string;
  qualifiedName?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface CodeRelationView {
  kind: string;
  from: string;
  to: string;
  evidence?: string;
}

export interface CodeSnippetView {
  symbolName?: string;
  qualifiedName?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  content: string;
}

export interface IndexContextResultView {
  query: { symbol?: string; file?: string };
  target?: CodeSymbolView;
  symbols: CodeSymbolView[];
  relatedFiles: string[];
  relations: CodeRelationView[];
  tests: CodeSymbolView[];
  snippets: CodeSnippetView[];
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) {
      return body.message.join(', ');
    }
    if (typeof body.message === 'string' && body.message.length > 0) {
      return body.message;
    }
  } catch {
    // ignore JSON parse errors
  }
  return `HTTP ${response.status}`;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE_URL}/api/health`);
  if (!response.ok) {
    throw new Error(`Health check failed: HTTP ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

export async function fetchIndexerHealth(): Promise<IndexerHealthResponse> {
  const response = await fetch(`${API_BASE_URL}/api/indexer/health`);
  if (!response.ok) {
    throw new Error(`Indexer health failed: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as IndexerHealthResponse;
}

export async function listProjects(): Promise<ProjectView[]> {
  const response = await fetch(`${API_BASE_URL}/api/projects`);
  if (!response.ok) {
    throw new Error(`No se pudo listar proyectos: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as ProjectView[];
}

export async function selectProject(path: string, name?: string): Promise<ProjectView> {
  const response = await fetch(`${API_BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name }),
  });
  if (!response.ok) {
    throw new Error(`No se pudo seleccionar el proyecto: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as ProjectView;
}

export async function getProject(id: string): Promise<ProjectView> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`No se pudo obtener el proyecto: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as ProjectView;
}

export async function updateProjectCommands(
  id: string,
  commands: ProjectCommandOverrides,
): Promise<ProjectView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(id)}/commands`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    },
  );
  if (!response.ok) {
    throw new Error(`No se pudieron guardar los comandos: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as ProjectView;
}

export async function getProjectIndex(projectId: string): Promise<ProjectIndexStatusView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/index`,
  );
  if (!response.ok) {
    throw new Error(`No se pudo obtener el índice: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as ProjectIndexStatusView;
}

export async function startProjectIndex(
  projectId: string,
  forceReindex = false,
): Promise<PipelineRunView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/index`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceReindex }),
    },
  );
  if (!response.ok) {
    throw new Error(`No se pudo indexar: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as PipelineRunView;
}

export async function fetchIndexContext(
  projectId: string,
  symbol: string,
  file?: string,
): Promise<IndexContextResultView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/index/context`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, file }),
    },
  );
  if (!response.ok) {
    throw new Error(`No se pudo obtener contexto: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as IndexContextResultView;
}

export interface PipelineDefinitionView {
  id: string;
  name: string;
  description: string;
  rollbackPolicy: string;
  steps: Array<{ stepId: string; name: string }>;
}

export interface PipelineRunRecord {
  id: string;
  pipelineDefinitionId: string;
  projectId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StepRunRecord {
  id: string;
  runId: string;
  stepId: string;
  name: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  resultJson: string | null;
  error: string | null;
  stepOrder: number;
}

export interface PipelineRunView {
  run: PipelineRunRecord;
  steps: StepRunRecord[];
}

export async function listPipelines(): Promise<PipelineDefinitionView[]> {
  const response = await fetch(`${API_BASE_URL}/api/pipelines`);
  if (!response.ok) {
    throw new Error(`No se pudieron listar pipelines: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as PipelineDefinitionView[];
}

export async function startPipelineRun(
  pipelineId: string,
  projectId: string,
  issueId?: string,
): Promise<PipelineRunView> {
  const response = await fetch(
    `${API_BASE_URL}/api/pipelines/${encodeURIComponent(pipelineId)}/runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...(issueId ? { issueId } : {}) }),
    },
  );
  if (!response.ok) {
    throw new Error(`No se pudo iniciar el pipeline: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as PipelineRunView;
}

export async function getPipelineRun(runId: string): Promise<PipelineRunView> {
  const response = await fetch(
    `${API_BASE_URL}/api/pipeline-runs/${encodeURIComponent(runId)}`,
  );
  if (!response.ok) {
    throw new Error(`No se pudo obtener el run: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as PipelineRunView;
}

export interface AgentHealthView {
  available: boolean;
  provider: string;
  version?: string;
  capabilities: string[];
  error?: string;
}

export interface LLMHealthView {
  available: boolean;
  provider: string;
  model?: string;
  error?: string;
}

export interface AgentProposalView {
  id: string;
  projectId: string;
  issueId: string;
  provider: string;
  providerVersion?: string;
  taskId: string;
  createdAt: string;
  summary: string;
  diagnosis?: string;
  proposedChanges: Array<{ file: string; description: string; rationale?: string }>;
  patch?: {
    version: number;
    edits: Array<{ file: string; startLine: number; endLine: number; expectedText: string; replacement: string }>;
    preconditions: Array<{ file: string; forbiddenPatterns: string[] }>;
  };
  affectedFiles: string[];
  agentSuggestedRisk: 'low' | 'medium' | 'high' | 'unknown';
  validationPlan: string[];
  assumptions?: string[];
  warnings?: string[];
  durationMs?: number;
  repositoryUnchanged: boolean;
  status: 'completed' | 'approved' | 'rejected';
  approvedAt?: string;
  approvedBy?: string;
  remediationStrategy?: 'local' | 'llm' | 'agent' | 'manual';
  remediationReason?: string;
  estimatedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextRevision?: string;
  requiresAgent?: boolean;
  executionTrace?: {
    indexProvider?: string;
    indexState?: string;
    targetSymbol?: string;
    filesIncluded: string[];
    symbolsIncluded: number;
    snippetsIncluded: number;
    snippetChars: number;
    promptChars: number;
    promptSha256: string;
    promptPreview: string;
    promptPreviewTruncated: boolean;
  };
}

export interface BulkProposalGroupView {
  id: string;
  rule: string;
  file: string;
  issueIds: string[];
  status: 'success' | 'failed';
  prompt: string;
  promptChars: number;
  estimatedInputTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedOutputTokens: number;
  model?: string;
  durationMs: number;
  proposalIds: string[];
  splitFrom?: string;
  retryDepth?: number;
  attempts?: number;
  recoveryPrompt?: string;
  error?: string;
}

export interface BulkProposalView {
  selected: number;
  eligible: number;
  proposed: number;
  reused: Array<{ issueId: string; proposalId: string; reason: string }>;
  skipped: Array<{ issueId: string; reason: string }>;
  groups: BulkProposalGroupView[];
}

export interface FixApplicationReportView {
  id: string;
  runId: string;
  projectId: string;
  issueId: string;
  proposalId: string;
  approvedBy: string;
  approvedAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  data: {
    changes?: { changedFiles?: string[]; createdFiles?: string[]; deletedFiles?: string[]; linesAdded?: number; linesRemoved?: number; diff?: string };
    validations?: Record<string, { status?: string; summary?: string; durationMs?: number }>;
    quality?: { targetResolved?: boolean; totalDelta?: number; newIssues?: QualityIssueView[]; before?: QualitySnapshotView; after?: QualitySnapshotView };
    rollback?: { restoredFiles?: string[]; verified?: boolean };
    repository?: { state?: string; readyForHumanReview?: boolean };
  };
}

export async function fetchAgentHealth(): Promise<AgentHealthView> {
  const response = await fetch(`${API_BASE_URL}/api/agent/health`);
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as AgentHealthView;
}

export async function fetchLLMHealth(): Promise<LLMHealthView> {
  const response = await fetch(`${API_BASE_URL}/api/llm/health`);
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as LLMHealthView;
}

export async function proposeQualityFix(
  projectId: string,
  issueId: string,
  options: { forceAI?: boolean } = {},
): Promise<PipelineRunView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/proposals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceAI: options.forceAI === true }),
    },
  );
  if (!response.ok) {
    throw new Error(`No se pudo proponer el fix: ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as PipelineRunView;
}

export async function proposeQualityFixesInBulk(
  projectId: string,
  issueIds: string[],
): Promise<BulkProposalView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/bulk-proposals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIds }),
    },
  );
  if (!response.ok) throw new Error(`No se pudieron generar las propuestas agrupadas: ${await readErrorMessage(response)}`);
  return (await response.json()) as BulkProposalView;
}

export async function listAgentProposals(
  projectId: string,
  issueId: string,
): Promise<AgentProposalView[]> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/proposals`,
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as AgentProposalView[];
}

export async function listProjectAgentProposals(projectId: string): Promise<AgentProposalView[]> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/proposals`,
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as AgentProposalView[];
}

export async function applyAgentProposal(
  projectId: string,
  issueId: string,
  proposalId: string,
  options: { forceAgent?: boolean } = {},
): Promise<PipelineRunView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'local-developer', forceAgent: options.forceAgent === true }),
    },
  );
  if (!response.ok) throw new Error(`No se pudo aplicar el fix: ${await readErrorMessage(response)}`);
  return (await response.json()) as PipelineRunView;
}

export async function applyAgentProposalsInBulk(
  projectId: string,
  proposalIds: string[],
): Promise<PipelineRunView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/proposals/bulk-apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalIds, approvedBy: 'local-developer' }),
    },
  );
  if (!response.ok) throw new Error(`No se pudieron aplicar las propuestas: ${await readErrorMessage(response)}`);
  return (await response.json()) as PipelineRunView;
}

export async function rejectAgentProposal(projectId: string, issueId: string, proposalId: string): Promise<AgentProposalView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as AgentProposalView;
}

export async function listFixApplications(projectId: string, issueId: string, proposalId: string): Promise<FixApplicationReportView[]> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/proposals/${encodeURIComponent(proposalId)}/applications`,
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as FixApplicationReportView[];
}

export async function listPipelineRuns(): Promise<PipelineRunRecord[]> {
  const response = await fetch(`${API_BASE_URL}/api/pipeline-runs`);
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as PipelineRunRecord[];
}

/* ── Quality (NestJS → QualityProvider; never calls Sonar from the browser) ── */

export interface QualityConfigView {
  projectId: string;
  provider: string;
  projectKey: string;
  sonarProjectName: string | null;
  autoCreateProject: boolean;
  suggestedProjectKey: string | null;
  baseUrl: string;
  baseUrlOverride: string | null;
  authenticationConfigured: boolean;
  projectState: string;
  updatedAt: string | null;
}

export interface QualityConnectionTestView {
  status: string;
  provider: string;
  project?: { provider: string; key: string; name: string };
  version?: string;
  message?: string;
  authenticationConfigured: boolean;
  projectState?: string;
}

export interface QualityScannerHealthView {
  available: boolean;
  analyzer: string | null;
  version?: string;
  command?: string;
  error?: string;
}

export interface QualityCreateProjectView {
  status: string;
  provider: string;
  project?: { provider: string; key: string; name: string };
  created: boolean;
  message?: string;
  createdAt?: string;
}

export interface QualityIssueView {
  id: string;
  provider: string;
  rule: string;
  severity: string;
  type?: string;
  status?: string;
  message: string;
  file: string;
  line?: number;
  effort?: string;
  tags?: string[];
  creationDate?: string;
  updateDate?: string;
}

export interface QualityIssuesPageView {
  issues: QualityIssueView[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  severityCounts?: Record<string, number>;
  typeCounts?: Record<string, number>;
}

export interface QualitySnapshotView {
  id: string;
  projectId: string;
  provider: string;
  createdAt: string;
  totalIssues: number;
  severityCounts: Record<string, number>;
  typeCounts: Record<string, number> | null;
  openIssues: number;
  resolvedIssues: number;
  statusCounts: Record<string, number>;
}

export interface QualitySnapshotDetailView {
  snapshot: QualitySnapshotView;
  issues: QualityIssueView[];
}

export interface QualityIssueReportView {
  generatedAt: string;
  source: 'sqlite';
  generatedWithAI: false;
  project: { id: string; name: string; path: string; createdAt: string; updatedAt: string };
  issue: QualityIssueView;
  resolution: {
    resolved: boolean;
    currentStatus: string;
    problem: string;
    solution: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    latestSnapshotId: string | null;
  };
  snapshotHistory: Array<{
    snapshotId: string;
    snapshotCreatedAt: string;
    snapshotTotalIssues: number;
    status: string | null;
    severity: string;
    updateDate: string | null;
  }>;
  proposals: AgentProposalView[];
  applications: FixApplicationReportView[];
}

export interface QualityIssueContextView {
  issue: QualityIssueView;
  codeContext?: IndexContextResultView;
  warnings: string[];
  indexState?: string;
}

export async function getQualityConfig(
  projectId: string,
): Promise<QualityConfigView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/config`,
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo obtener la config de calidad: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityConfigView;
}

export async function updateQualityConfig(
  projectId: string,
  body: {
    projectKey: string;
    sonarProjectName?: string | null;
    autoCreateProject?: boolean;
    baseUrlOverride?: string | null;
  },
): Promise<QualityConfigView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/config`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo guardar la config de calidad: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityConfigView;
}

export async function createQualityProject(
  projectId: string,
): Promise<QualityCreateProjectView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/create-project`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo crear el proyecto de calidad: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityCreateProjectView;
}

export async function fetchQualityScannerHealth(
  projectId: string,
): Promise<QualityScannerHealthView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/scanner-health`,
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo consultar el scanner: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityScannerHealthView;
}

export async function testQualityConnection(
  projectId: string,
): Promise<QualityConnectionTestView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/test-connection`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo probar la conexión: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityConnectionTestView;
}

export async function fetchQualityIssues(
  projectId: string,
  params: {
    page?: number;
    pageSize?: number;
    severity?: string;
    type?: string;
    search?: string;
  } = {},
): Promise<QualityIssuesPageView> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.severity) qs.set('severity', params.severity);
  if (params.type) qs.set('type', params.type);
  if (params.search) qs.set('search', params.search);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues${suffix}`,
  );
  if (!response.ok) {
    throw new Error(
      `No se pudieron listar issues: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityIssuesPageView;
}

export async function fetchQualityIssueContext(
  projectId: string,
  issueId: string,
): Promise<QualityIssueContextView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/context`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo obtener el contexto del issue: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualityIssueContextView;
}

export async function listQualitySnapshots(
  projectId: string,
): Promise<QualitySnapshotView[]> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/snapshots`,
  );
  if (!response.ok) {
    throw new Error(
      `No se pudieron listar snapshots: ${await readErrorMessage(response)}`,
    );
  }
  return (await response.json()) as QualitySnapshotView[];
}

export async function getQualitySnapshot(
  projectId: string,
  snapshotId: string,
): Promise<QualitySnapshotDetailView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/snapshots/${encodeURIComponent(snapshotId)}`,
  );
  if (!response.ok) throw new Error(`No se pudo cargar el snapshot: ${await readErrorMessage(response)}`);
  return (await response.json()) as QualitySnapshotDetailView;
}

export async function getQualityIssueReport(
  projectId: string,
  issueId: string,
): Promise<QualityIssueReportView> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/quality/issues/${encodeURIComponent(issueId)}/report`,
  );
  if (!response.ok) throw new Error(`No se pudo generar el informe: ${await readErrorMessage(response)}`);
  return (await response.json()) as QualityIssueReportView;
}
