import { redactSecretsInText } from '@amp/core';
import type {
  GetQualityAnalysisActivityInput,
  GetQualityAnalysisTaskInput,
  GetQualityIssueInput,
  GetQualityIssuesInput,
  GetQualityIssuesResult,
  QualityAnalysisTaskRef,
  QualityConnectionStatus,
  QualityConnectionTestResult,
  QualityCreateProjectInput,
  QualityCreateProjectResult,
  QualityEnsureProjectInput,
  QualityEnsureProjectResult,
  QualityIssue,
  QualityIssueFilters,
  QualityProcessingStatus,
  QualityProject,
  QualityProviderConfig,
  QualityProviderHealth,
} from '@amp/core';
import type { QualityProvider } from './quality-provider';
import {
  QUALITY_DEFAULT_PAGE_SIZE,
  QUALITY_MAX_PAGE_SIZE,
} from './quality-provider';

export type SonarFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Auth scheme for SonarQube 9.9.x user tokens.
 * Verified on a live 9.9.8 instance:
 * - Bearer works for /api/system/status and /api/server/version
 * - Authenticated APIs (projects/*, ce/*, issues/*) require Basic user-token
 *   (username = token, password empty). Default is therefore basic-token.
 */
export type SonarAuthMode = 'basic-token' | 'bearer';

export interface SonarQualityProviderOptions {
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: SonarFetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
  providerName?: string;
  /** Defaults to basic-token (required for create/CE on Sonar 9.9.8). */
  authMode?: SonarAuthMode;
}

interface SonarHttpResult {
  status: number;
  ok: boolean;
  bodyText: string;
  timedOut: boolean;
  networkError: boolean;
}

/**
 * SonarQube Web API QualityProvider (API paths encapsulated here only).
 * Verified against SonarQube 9.9.x:
 * - GET  /api/system/status
 * - GET  /api/server/version
 * - GET  /api/projects/search
 * - POST /api/projects/create
 * - GET  /api/issues/search
 * - GET  /api/ce/task
 * - GET  /api/ce/activity
 * Does NOT execute scanners — that is QualityAnalyzer.
 */
export class SonarQualityProvider implements QualityProvider {
  readonly name: string;
  private readonly fetchImpl: SonarFetch;
  private readonly timeoutMs: number;
  private readonly authMode: SonarAuthMode;

  constructor(options: SonarQualityProviderOptions = {}) {
    this.name = options.providerName ?? 'sonar';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.authMode = options.authMode ?? 'basic-token';
  }

  async health(config: QualityProviderConfig): Promise<QualityProviderHealth> {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!baseUrl) {
      return {
        provider: this.name,
        online: false,
        connectionStatus: 'SERVER_UNAVAILABLE',
        error: 'Quality base URL is not configured',
      };
    }

    const result = await this.request(baseUrl, '/api/system/status', {
      authToken: config.authToken,
      method: 'GET',
    });

    if (result.timedOut) {
      return {
        provider: this.name,
        online: false,
        connectionStatus: 'TIMEOUT',
        error: 'Quality server timed out',
      };
    }
    if (result.networkError) {
      return {
        provider: this.name,
        online: false,
        connectionStatus: 'SERVER_UNAVAILABLE',
        error: 'Quality server unreachable',
      };
    }

    if (result.status === 401) {
      return {
        provider: this.name,
        online: true,
        connectionStatus: 'AUTHENTICATION_FAILED',
        error: 'Authentication failed',
      };
    }
    if (result.status === 403) {
      return {
        provider: this.name,
        online: true,
        connectionStatus: 'FORBIDDEN',
        error: 'Forbidden',
      };
    }
    if (!result.ok) {
      return {
        provider: this.name,
        online: false,
        connectionStatus: 'UNKNOWN_ERROR',
        error: `Unexpected status ${result.status}`,
      };
    }

    const parsed = parseJsonObject(result.bodyText);
    const version =
      typeof parsed?.version === 'string' ? parsed.version : undefined;
    const serverId = typeof parsed?.id === 'string' ? parsed.id : undefined;
    const status =
      typeof parsed?.status === 'string' ? parsed.status : undefined;
    const online = !status || status.toUpperCase() === 'UP';

    return {
      provider: this.name,
      online,
      version,
      serverId,
      connectionStatus: online ? 'CONNECTED' : 'SERVER_UNAVAILABLE',
    };
  }

  async testConnection(
    config: QualityProviderConfig,
  ): Promise<QualityConnectionTestResult> {
    const authenticationConfigured = Boolean(
      config.authToken && config.authToken.length > 0,
    );
    const baseUrl = normalizeBaseUrl(config.baseUrl);

    if (!baseUrl) {
      return {
        status: 'SERVER_UNAVAILABLE',
        provider: this.name,
        authenticationConfigured,
        message: 'Quality base URL is not configured',
      };
    }

    const health = await this.health(config);
    if (
      health.connectionStatus === 'TIMEOUT' ||
      health.connectionStatus === 'SERVER_UNAVAILABLE'
    ) {
      return {
        status: health.connectionStatus,
        provider: this.name,
        authenticationConfigured,
        version: health.version,
        message: health.error,
      };
    }

    if (!authenticationConfigured) {
      return {
        status: 'AUTHENTICATION_FAILED',
        provider: this.name,
        authenticationConfigured: false,
        version: health.version,
        message: 'Quality credential is not configured',
      };
    }

    if (!config.projectKey.trim()) {
      return {
        status: 'PROJECT_NOT_FOUND',
        provider: this.name,
        authenticationConfigured,
        version: health.version,
        message: 'Project key is required',
      };
    }

    const search = await this.request(baseUrl, '/api/projects/search', {
      authToken: config.authToken,
      method: 'GET',
      query: {
        projects: config.projectKey.trim(),
        ps: '1',
      },
    });

    const mapped = mapHttpToConnectionStatus(search);
    if (mapped !== 'CONNECTED') {
      return {
        status: mapped,
        provider: this.name,
        authenticationConfigured,
        version: health.version,
        message: connectionMessage(mapped),
      };
    }

    const project = extractProjectFromSearch(
      search.bodyText,
      config.projectKey.trim(),
      this.name,
    );

    if (!project) {
      return {
        status: 'PROJECT_NOT_FOUND',
        provider: this.name,
        authenticationConfigured,
        version: health.version,
        message: 'Project key not found on quality server',
      };
    }

    return {
      status: 'CONNECTED',
      provider: this.name,
      authenticationConfigured,
      version: health.version,
      project,
      message: 'Connected',
    };
  }

  async getProject(
    config: QualityProviderConfig,
  ): Promise<QualityProject | null> {
    const result = await this.testConnection(config);
    return result.project ?? null;
  }

  async ensureProject(
    input: QualityEnsureProjectInput,
  ): Promise<QualityEnsureProjectResult> {
    const { config, autoCreate } = input;
    const name =
      (input.projectName ?? config.projectName ?? config.projectKey).trim() ||
      config.projectKey.trim();

    if (!config.authToken) {
      return {
        status: 'AUTHENTICATION_FAILED',
        provider: this.name,
        created: false,
        message: 'Quality credential is not configured',
      };
    }

    const existing = await this.getProject(config);
    if (existing) {
      return {
        status: 'PROJECT_EXISTS',
        provider: this.name,
        project: existing,
        created: false,
        message: 'Project already exists',
      };
    }

    // Distinguish auth failure from missing project (getProject via testConnection).
    const probe = await this.testConnection(config);
    if (
      probe.status === 'AUTHENTICATION_FAILED' ||
      probe.status === 'FORBIDDEN' ||
      probe.status === 'SERVER_UNAVAILABLE' ||
      probe.status === 'TIMEOUT'
    ) {
      return {
        status: probe.status,
        provider: this.name,
        created: false,
        message: probe.message,
      };
    }

    if (!autoCreate) {
      return {
        status: 'PROJECT_NOT_FOUND',
        provider: this.name,
        created: false,
        message: 'Project not found and auto-create is disabled',
      };
    }

    return this.createProject({ config, projectName: name });
  }

  async createProject(
    input: QualityCreateProjectInput,
  ): Promise<QualityCreateProjectResult> {
    const baseUrl = normalizeBaseUrl(input.config.baseUrl);
    const projectKey = input.config.projectKey.trim();
    const projectName = input.projectName.trim() || projectKey;
    const createdAt = new Date().toISOString();

    if (!baseUrl) {
      return {
        status: 'SERVER_UNAVAILABLE',
        provider: this.name,
        created: false,
        message: 'Quality base URL is not configured',
      };
    }
    if (!input.config.authToken) {
      return {
        status: 'AUTHENTICATION_FAILED',
        provider: this.name,
        created: false,
        message: 'Quality credential is not configured — cannot create project',
      };
    }
    if (!projectKey) {
      return {
        status: 'PROJECT_NOT_FOUND',
        provider: this.name,
        created: false,
        message: 'Project key is required',
      };
    }

    // Idempotent: if already present, do not create again.
    const existing = await this.findProjectByKey(
      baseUrl,
      projectKey,
      input.config.authToken,
    );
    if (existing) {
      return {
        status: 'PROJECT_EXISTS',
        provider: this.name,
        project: existing,
        created: false,
        message: 'Project already exists',
        createdAt,
      };
    }

    const response = await this.request(baseUrl, '/api/projects/create', {
      authToken: input.config.authToken,
      method: 'POST',
      form: {
        project: projectKey,
        name: projectName,
      },
    });

    if (response.status === 401) {
      return {
        status: 'AUTHENTICATION_FAILED',
        provider: this.name,
        created: false,
        message: 'Authentication failed',
      };
    }
    if (response.status === 403) {
      return {
        status: 'CREATE_FORBIDDEN',
        provider: this.name,
        created: false,
        message: 'Forbidden to create quality project',
      };
    }
    if (response.timedOut) {
      return {
        status: 'TIMEOUT',
        provider: this.name,
        created: false,
        message: 'Quality server timed out',
      };
    }
    if (response.networkError) {
      return {
        status: 'SERVER_UNAVAILABLE',
        provider: this.name,
        created: false,
        message: 'Quality server unreachable',
      };
    }

    // Sonar may return 400 when key already exists (race) — re-check.
    if (!response.ok) {
      const raced = await this.findProjectByKey(
        baseUrl,
        projectKey,
        input.config.authToken,
      );
      if (raced) {
        return {
          status: 'PROJECT_EXISTS',
          provider: this.name,
          project: raced,
          created: false,
          message: 'Project already exists',
          createdAt,
        };
      }
      return {
        status: 'UNKNOWN_ERROR',
        provider: this.name,
        created: false,
        message: `Unexpected status ${response.status}`,
      };
    }

    const body = parseJsonObject(response.bodyText);
    const projectNode =
      body?.project && typeof body.project === 'object'
        ? (body.project as Record<string, unknown>)
        : body;
    const project: QualityProject = {
      provider: this.name,
      key: String(projectNode?.key ?? projectKey),
      name: String(projectNode?.name ?? projectName),
    };

    return {
      status: 'CONNECTED',
      provider: this.name,
      project,
      created: true,
      message: 'Project created',
      createdAt,
    };
  }

  async getIssues(
    input: GetQualityIssuesInput,
  ): Promise<GetQualityIssuesResult> {
    const baseUrl = normalizeBaseUrl(input.config.baseUrl);
    const page = Math.max(1, input.page ?? 1);
    const pageSize = clampPageSize(input.pageSize);
    if (!baseUrl || !input.config.projectKey.trim()) {
      return {
        issues: [],
        page,
        pageSize,
        total: 0,
        hasMore: false,
        severityCounts: {},
        typeCounts: {},
      };
    }

    const query: Record<string, string> = {
      componentKeys: input.config.projectKey.trim(),
      p: String(page),
      ps: String(pageSize),
      facets: 'severities,types',
    };
    applyIssueFilters(query, input.filters);

    const response = await this.request(baseUrl, '/api/issues/search', {
      authToken: input.config.authToken,
      method: 'GET',
      query,
    });

    assertOkForData(response);

    const body = parseJsonObject(response.bodyText);
    if (!body) {
      throw new QualityProviderError(
        'UNKNOWN_ERROR',
        'Malformed quality issues response',
      );
    }

    const rawIssues = Array.isArray(body.issues) ? body.issues : null;
    if (!rawIssues) {
      throw new QualityProviderError(
        'UNKNOWN_ERROR',
        'Malformed quality issues response',
      );
    }

    const total = readTotal(body);
    const paging = body.paging as Record<string, unknown> | undefined;
    if ((paging?.pageIndex !== undefined && paging.pageIndex !== page)
      || (paging?.pageSize !== undefined && paging.pageSize !== pageSize)) {
      throw new QualityProviderError('UNKNOWN_ERROR', 'Unexpected quality issue pagination');
    }
    const issues = rawIssues.map((item) => mapIssue(item, this.name, input.config.projectKey));
    if (issues.some((issue) => issue === null)) {
      throw new QualityProviderError('UNKNOWN_ERROR', 'Malformed quality issue: missing issue identity');
    }

    const facets = Array.isArray(body.facets) ? body.facets : [];
    const severityCounts = readFacetCounts(facets, 'severities');
    const typeCounts = readFacetCounts(facets, 'types');

    return {
      issues: issues as QualityIssue[],
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      severityCounts,
      typeCounts,
    };
  }

  async getIssue(input: GetQualityIssueInput): Promise<QualityIssue | null> {
    const baseUrl = normalizeBaseUrl(input.config.baseUrl);
    if (!baseUrl || !input.issueId.trim()) {
      return null;
    }

    const response = await this.request(baseUrl, '/api/issues/search', {
      authToken: input.config.authToken,
      method: 'GET',
      query: {
        issues: input.issueId.trim(),
        componentKeys: input.config.projectKey.trim(),
        ps: '1',
      },
    });

    if (response.status === 404) {
      return null;
    }
    assertOkForData(response);

    const body = parseJsonObject(response.bodyText);
    const rawIssues = Array.isArray(body?.issues) ? body.issues : [];
    if (rawIssues.length === 0) {
      return null;
    }
    return mapIssue(rawIssues[0], this.name, input.config.projectKey);
  }

  async getAnalysisTask(
    input: GetQualityAnalysisTaskInput,
  ): Promise<QualityAnalysisTaskRef | null> {
    const baseUrl = normalizeBaseUrl(input.config.baseUrl);
    const taskId = input.taskId.trim();
    if (!baseUrl || !taskId) {
      return null;
    }

    const response = await this.request(baseUrl, '/api/ce/task', {
      authToken: input.config.authToken,
      method: 'GET',
      query: { id: taskId },
    });

    if (response.status === 404) {
      return null;
    }
    assertOkForData(response);

    const body = parseJsonObject(response.bodyText);
    const task =
      body?.task && typeof body.task === 'object'
        ? (body.task as Record<string, unknown>)
        : null;
    if (!task) {
      return null;
    }
    return mapCeTask(task);
  }

  async getLatestAnalysisActivity(
    input: GetQualityAnalysisActivityInput,
  ): Promise<QualityAnalysisTaskRef | null> {
    const baseUrl = normalizeBaseUrl(input.config.baseUrl);
    const projectKey = input.config.projectKey.trim();
    if (!baseUrl || !projectKey) {
      return null;
    }

    const query: Record<string, string> = {
      component: projectKey,
      ps: '1',
    };
    if (input.onlyCurrents !== false) {
      query.onlyCurrents = 'true';
    }

    const response = await this.request(baseUrl, '/api/ce/activity', {
      authToken: input.config.authToken,
      method: 'GET',
      query,
    });

    assertOkForData(response);

    const body = parseJsonObject(response.bodyText);
    const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
    if (tasks.length === 0) {
      return null;
    }
    const first = tasks[0];
    if (!first || typeof first !== 'object') {
      return null;
    }
    return mapCeTask(first as Record<string, unknown>);
  }

  private async findProjectByKey(
    baseUrl: string,
    projectKey: string,
    authToken: string | undefined,
  ): Promise<QualityProject | null> {
    const search = await this.request(baseUrl, '/api/projects/search', {
      authToken,
      method: 'GET',
      query: { projects: projectKey, ps: '1' },
    });
    if (!search.ok) {
      return null;
    }
    return extractProjectFromSearch(search.bodyText, projectKey, this.name);
  }

  private async request(
    baseUrl: string,
    apiPath: string,
    options: {
      authToken?: string;
      method: string;
      query?: Record<string, string>;
      form?: Record<string, string>;
    },
  ): Promise<SonarHttpResult> {
    const url = buildUrl(baseUrl, apiPath, options.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    applyAuthHeader(headers, options.authToken, this.authMode);

    let body: string | undefined;
    if (options.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        bodyText: sanitizeBody(bodyText, options.authToken),
        timedOut: false,
        networkError: false,
      };
    } catch (err: unknown) {
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'AbortError');
      if (aborted) {
        return {
          status: 0,
          ok: false,
          bodyText: '',
          timedOut: true,
          networkError: false,
        };
      }
      return {
        status: 0,
        ok: false,
        bodyText: '',
        timedOut: false,
        networkError: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class QualityProviderError extends Error {
  readonly status: QualityConnectionStatus;

  constructor(status: QualityConnectionStatus, message: string) {
    super(message);
    this.name = 'QualityProviderError';
    this.status = status;
  }
}

function applyAuthHeader(
  headers: Record<string, string>,
  token: string | undefined,
  mode: SonarAuthMode,
): void {
  if (!token) {
    return;
  }
  if (mode === 'bearer') {
    headers.Authorization = `Bearer ${token}`;
    return;
  }
  // SonarQube user token: Basic base64("token:")
  const encoded = Buffer.from(`${token}:`, 'utf8').toString('base64');
  headers.Authorization = `Basic ${encoded}`;
}

function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) {
    return '';
  }
  return raw.trim().replace(/\/+$/, '');
}

function buildUrl(
  baseUrl: string,
  apiPath: string,
  query?: Record<string, string>,
): string {
  const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

function clampPageSize(raw: number | undefined): number {
  const n = raw ?? QUALITY_DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(n) || n < 1) {
    return QUALITY_DEFAULT_PAGE_SIZE;
  }
  return Math.min(QUALITY_MAX_PAGE_SIZE, Math.floor(n));
}

function applyIssueFilters(
  query: Record<string, string>,
  filters: QualityIssueFilters | undefined,
): void {
  if (!filters) {
    return;
  }
  if (filters.severity?.trim()) {
    query.severities = filters.severity.trim().toUpperCase();
  }
  if (filters.type?.trim()) {
    query.types = filters.type.trim().toUpperCase();
  }
  if (filters.status?.trim()) {
    query.statuses = filters.status.trim().toUpperCase();
  }
  if (filters.rule?.trim()) {
    query.rules = filters.rule.trim();
  }
  if (filters.file?.trim()) {
    query.files = filters.file.trim();
  }
  if (filters.search?.trim()) {
    query.q = filters.search.trim();
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractProjectFromSearch(
  bodyText: string,
  projectKey: string,
  provider: string,
): QualityProject | null {
  const body = parseJsonObject(bodyText);
  const components = Array.isArray(body?.components) ? body.components : [];
  const match = components.find((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const row = item as Record<string, unknown>;
    return String(row.key ?? '') === projectKey;
  });
  if (!match || typeof match !== 'object') {
    return null;
  }
  const row = match as Record<string, unknown>;
  return {
    provider,
    key: String(row.key ?? projectKey),
    name: String(row.name ?? row.key ?? projectKey),
  };
}

/**
 * Maps Sonar CE task status (PENDING|IN_PROGRESS|SUCCESS|FAILED|CANCELED)
 * into domain QualityProcessingStatus.
 */
export function mapSonarCeStatus(raw: string | undefined): QualityProcessingStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'IN_PROGRESS':
      return 'in_progress';
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
    case 'CANCELED':
      return 'failed';
    default:
      return 'pending';
  }
}

function mapCeTask(task: Record<string, unknown>): QualityAnalysisTaskRef {
  const taskId = String(task.id ?? '');
  const vendorStatus =
    typeof task.status === 'string' ? task.status : undefined;
  return {
    taskId,
    analysisId:
      typeof task.analysisId === 'string' ? task.analysisId : undefined,
    status: mapSonarCeStatus(vendorStatus),
    vendorStatus,
    submittedAt:
      typeof task.submittedAt === 'string' ? task.submittedAt : undefined,
    executedAt:
      typeof task.executedAt === 'string' ? task.executedAt : undefined,
    errorMessage:
      typeof task.errorMessage === 'string' ? task.errorMessage : undefined,
  };
}

function mapHttpToConnectionStatus(
  result: SonarHttpResult,
): QualityConnectionStatus {
  if (result.timedOut) {
    return 'TIMEOUT';
  }
  if (result.networkError) {
    return 'SERVER_UNAVAILABLE';
  }
  if (result.status === 401) {
    return 'AUTHENTICATION_FAILED';
  }
  if (result.status === 403) {
    return 'FORBIDDEN';
  }
  if (result.status === 404) {
    return 'PROJECT_NOT_FOUND';
  }
  if (!result.ok) {
    return 'UNKNOWN_ERROR';
  }
  return 'CONNECTED';
}

function connectionMessage(status: QualityConnectionStatus): string {
  switch (status) {
    case 'TIMEOUT':
      return 'Quality server timed out';
    case 'SERVER_UNAVAILABLE':
      return 'Quality server unreachable';
    case 'AUTHENTICATION_FAILED':
      return 'Authentication failed';
    case 'FORBIDDEN':
      return 'Forbidden';
    case 'CREATE_FORBIDDEN':
      return 'Forbidden to create quality project';
    case 'PROJECT_NOT_FOUND':
      return 'Project not found';
    case 'PROJECT_EXISTS':
      return 'Project already exists';
    case 'CONNECTED':
      return 'Connected';
    default:
      return 'Unknown quality provider error';
  }
}

function assertOkForData(result: SonarHttpResult): void {
  const status = mapHttpToConnectionStatus(result);
  if (status !== 'CONNECTED') {
    throw new QualityProviderError(status, connectionMessage(status));
  }
}

function readTotal(body: Record<string, unknown>): number {
  const paging = body.paging;
  if (paging && typeof paging === 'object' && !Array.isArray(paging)) {
    const total = (paging as Record<string, unknown>).total;
    if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) {
      return total;
    }
  }
  if (typeof body.total === 'number' && Number.isSafeInteger(body.total) && body.total >= 0) {
    return body.total;
  }
  throw new QualityProviderError('UNKNOWN_ERROR', 'Missing or invalid quality issue total');
}

function readFacetCounts(
  facets: unknown[],
  property: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const facet of facets) {
    if (!facet || typeof facet !== 'object') {
      continue;
    }
    const row = facet as Record<string, unknown>;
    if (String(row.property ?? '') !== property) {
      continue;
    }
    const values = Array.isArray(row.values) ? row.values : [];
    for (const value of values) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const key = String(entry.val ?? '');
      const count = Number(entry.count ?? 0);
      if (key && Number.isFinite(count)) {
        out[key] = count;
      }
    }
  }
  return out;
}

function mapIssue(raw: unknown, provider: string, projectKey?: string): QualityIssue | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.key === 'string' ? row.key : '';
  if (!id) {
    return null;
  }
  const component =
    typeof row.component === 'string'
      ? row.component
      : typeof row.componentLongName === 'string'
        ? row.componentLongName
        : '';
  const file = projectKey && component.startsWith(`${projectKey}:`)
    ? component.slice(projectKey.length + 1)
    : component.includes(':')
    ? component.slice(component.indexOf(':') + 1)
    : component;

  const line =
    typeof row.line === 'number' && Number.isFinite(row.line)
      ? row.line
      : undefined;

  const tags = Array.isArray(row.tags)
    ? row.tags.filter((t): t is string => typeof t === 'string')
    : undefined;

  return {
    id,
    provider,
    rule: typeof row.rule === 'string' ? row.rule : 'unknown',
    severity: typeof row.severity === 'string' ? row.severity : 'UNKNOWN',
    type: typeof row.type === 'string' ? row.type : undefined,
    status: typeof row.status === 'string' ? row.status : undefined,
    message: typeof row.message === 'string' ? row.message : '',
    file,
    line,
    effort: typeof row.effort === 'string' ? row.effort : undefined,
    tags,
    creationDate:
      typeof row.creationDate === 'string' ? row.creationDate : undefined,
    updateDate: typeof row.updateDate === 'string' ? row.updateDate : undefined,
  };
}

function sanitizeBody(body: string, token: string | undefined): string {
  if (!token) {
    return body;
  }
  return redactSecretsInText(body, [token]);
}
