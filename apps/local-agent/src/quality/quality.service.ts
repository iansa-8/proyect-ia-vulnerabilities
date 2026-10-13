import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  GatewayTimeoutException,
} from '@nestjs/common';
import path from 'node:path';
import type {
  GetQualityIssuesResult,
  QualityAnalyzerHealth,
  QualityConnectionTestResult,
  QualityCreateProjectResult,
  QualityIssue,
  QualityIssueFilters,
  QualityProjectState,
  QualityProviderConfig,
  QualityProviderHealth,
} from '@amp/core';
import {
  QUALITY_MAX_PAGE_SIZE,
  QualityProviderError,
  type QualityAnalyzerRegistry,
  type QualityProvider,
} from '@amp/providers';
import { loadConfig } from '../config/app-config';
import { ProjectRepository } from '../persistence/project.repository';
import { ProjectQualityConfigRepository } from '../persistence/project-quality-config.repository';
import { AgentProposalRepository } from '../persistence/agent-proposal.repository';
import { FixApplicationRepository } from '../persistence/fix-application.repository';
import {
  QualitySnapshotRepository,
  type QualitySnapshotRecord,
} from '../persistence/quality-snapshot.repository';
import {
  QUALITY_ANALYZER_REGISTRY,
  QUALITY_PROVIDER,
} from '../providers/tokens';
import {
  QualityIssueContextService,
  type QualityIssueContext,
} from './quality-issue-context.service';
import { assertSonarUrlAllowed, buildQualityProviderConfig } from './quality-config.util';
import { readExistingSonarProperties } from './node-sonar-analyzer';

export interface ProjectQualityConfigView {
  projectId: string;
  provider: string;
  projectKey: string;
  sonarProjectName: string | null;
  autoCreateProject: boolean;
  /** Suggested key from properties or directory name — not persisted until saved. */
  suggestedProjectKey: string | null;
  /** Effective URL (override or global) — never the token. */
  baseUrl: string;
  baseUrlOverride: string | null;
  authenticationConfigured: boolean;
  projectState: QualityProjectState;
  updatedAt: string | null;
}

export interface UpdateProjectQualityConfigInput {
  projectKey: string;
  sonarProjectName?: string | null;
  autoCreateProject?: boolean;
  baseUrlOverride?: string | null;
}

export interface QualityScannerHealthView {
  available: boolean;
  analyzer: string | null;
  version?: string;
  command?: string;
  error?: string;
}

export interface QualitySnapshotSummaryView extends QualitySnapshotRecord {
  openIssues: number;
  resolvedIssues: number;
  statusCounts: Record<string, number>;
}

@Injectable()
export class QualityService {
  constructor(
    @Inject(QUALITY_PROVIDER) private readonly quality: QualityProvider,
    @Inject(QUALITY_ANALYZER_REGISTRY)
    private readonly analyzers: QualityAnalyzerRegistry,
    private readonly projects: ProjectRepository,
    private readonly configs: ProjectQualityConfigRepository,
    private readonly snapshots: QualitySnapshotRepository,
    private readonly proposals: AgentProposalRepository,
    private readonly fixApplications: FixApplicationRepository,
    private readonly issueContext: QualityIssueContextService,
  ) {}

  getConfigView(projectId: string): ProjectQualityConfigView {
    const project = this.requireProject(projectId);
    const stored = this.configs.findByProjectId(projectId);
    const resolved = this.resolveConfig(projectId);
    const suggested = this.suggestProjectKey(project.path, stored?.projectKey);
    return {
      projectId,
      provider: stored?.provider ?? this.quality.name,
      projectKey: stored?.projectKey ?? '',
      sonarProjectName: stored?.sonarProjectName ?? null,
      autoCreateProject: stored?.autoCreateProject ?? false,
      suggestedProjectKey: suggested,
      baseUrl: resolved.baseUrl,
      baseUrlOverride: stored?.baseUrlOverride ?? null,
      authenticationConfigured: resolved.authenticationConfigured,
      projectState: this.deriveProjectState(stored, null),
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  updateConfig(
    projectId: string,
    input: UpdateProjectQualityConfigInput,
  ): ProjectQualityConfigView {
    this.requireProject(projectId);
    if (input.baseUrlOverride?.trim()) {
      try {
        assertSonarUrlAllowed(input.baseUrlOverride, loadConfig());
      } catch (error: unknown) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'URL de calidad no permitida',
        );
      }
    }
    this.configs.upsert({
      projectId,
      projectKey: input.projectKey.trim(),
      sonarProjectName:
        input.sonarProjectName === undefined
          ? undefined
          : input.sonarProjectName?.trim() || null,
      autoCreateProject: input.autoCreateProject,
      baseUrlOverride:
        input.baseUrlOverride === undefined
          ? undefined
          : input.baseUrlOverride?.trim() || null,
    });
    return this.getConfigView(projectId);
  }

  async testConnection(
    projectId: string,
  ): Promise<QualityConnectionTestResult & { projectState: QualityProjectState }> {
    this.requireProject(projectId);
    const stored = this.configs.findByProjectId(projectId);
    const config = this.resolveProviderConfig(projectId);
    const result = await this.quality.testConnection(config);
    return {
      ...result,
      authenticationConfigured: Boolean(config.authToken),
      message: result.message,
      projectState: this.deriveProjectState(stored, result.status),
    };
  }

  async createRemoteProject(
    projectId: string,
  ): Promise<QualityCreateProjectResult> {
    this.requireProject(projectId);
    const stored = this.configs.findByProjectId(projectId);
    const config = this.resolveProviderConfig(projectId);
    if (!config.authToken) {
      throw new UnauthorizedException(
        'Credencial de calidad no configurada — no se puede crear el proyecto',
      );
    }
    if (!config.projectKey.trim()) {
      throw new BadRequestException('Configura el project key antes de crear');
    }
    const name =
      stored?.sonarProjectName?.trim() ||
      config.projectName?.trim() ||
      config.projectKey.trim();
    const result = await this.quality.createProject({
      config,
      projectName: name,
    });
    if (
      result.status === 'CREATE_FORBIDDEN' ||
      result.status === 'FORBIDDEN'
    ) {
      throw new ForbiddenException(
        result.message ?? 'Sin permiso para crear el proyecto de calidad',
      );
    }
    if (result.status === 'AUTHENTICATION_FAILED') {
      throw new UnauthorizedException(
        result.message ?? 'Autenticación de calidad fallida',
      );
    }
    if (
      result.status === 'SERVER_UNAVAILABLE' ||
      result.status === 'TIMEOUT'
    ) {
      throw new ServiceUnavailableException(
        result.message ?? 'Servidor de calidad no disponible',
      );
    }
    if (
      result.status !== 'CONNECTED' &&
      result.status !== 'PROJECT_EXISTS'
    ) {
      throw new BadRequestException(
        result.message ?? 'No se pudo crear el proyecto de calidad',
      );
    }
    return result;
  }

  async scannerHealth(projectId: string): Promise<QualityScannerHealthView> {
    const project = this.requireProject(projectId);
    const profile = project.profile ?? {
      hasDocker: false,
      hasSonar: false,
    };
    const analyzer = this.analyzers.resolve(profile);
    if (!analyzer) {
      return {
        available: false,
        analyzer: null,
        error: 'No hay analizador de calidad para este stack',
      };
    }
    const health: QualityAnalyzerHealth = await analyzer.health();
    return {
      available: health.available,
      analyzer: analyzer.name,
      version: health.version,
      command: health.command,
      error: health.error,
    };
  }

  async health(projectId: string): Promise<QualityProviderHealth> {
    this.requireProject(projectId);
    const config = this.resolveProviderConfig(projectId);
    return this.quality.health(config);
  }

  async getIssues(
    projectId: string,
    options: {
      page?: number;
      pageSize?: number;
      filters?: QualityIssueFilters;
    },
  ): Promise<GetQualityIssuesResult> {
    this.requireProject(projectId);
    const config = this.resolveProviderConfig(projectId);
    if (!config.projectKey) {
      throw new BadRequestException(
        'Configura el project key de calidad antes de listar issues',
      );
    }
    try {
      return await this.quality.getIssues({
        config,
        page: options.page,
        pageSize: options.pageSize,
        filters: options.filters,
      });
    } catch (err: unknown) {
      throw this.mapProviderError(err);
    }
  }

  async getIssue(
    projectId: string,
    issueId: string,
  ): Promise<QualityIssue> {
    this.requireProject(projectId);
    const config = this.resolveProviderConfig(projectId);
    try {
      const issue = await this.quality.getIssue({ config, issueId });
      if (!issue) {
        throw new NotFoundException(`Issue no encontrado: ${issueId}`);
      }
      return issue;
    } catch (err: unknown) {
      if (err instanceof NotFoundException) {
        throw err;
      }
      throw this.mapProviderError(err);
    }
  }

  /** Fetch a complete, stable issue set; a partial download must never become a baseline. */
  async getAllIssues(projectId: string): Promise<GetQualityIssuesResult> {
    const pageSize = Math.min(QUALITY_MAX_PAGE_SIZE, loadConfig().quality.defaultPageSize);
    const issues: QualityIssue[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    let page = 1;
    while (true) {
      const batch = await this.getIssues(projectId, { page, pageSize });
      if (!Number.isSafeInteger(batch.total) || batch.total < 0
        || batch.page !== page || batch.pageSize !== pageSize || !Array.isArray(batch.issues)
        || batch.issues.length > pageSize || (total !== undefined && batch.total !== total)) {
        throw new BadRequestException('Invalid or changing issue pagination; retry the baseline');
      }
      total = batch.total;
      if (total > loadConfig().quality.downloadMaxIssues) throw new BadRequestException('Quality download limit exceeded; no partial snapshot was created');
      for (const issue of batch.issues) {
        if (!issue?.id || seen.has(issue.id)) throw new BadRequestException('Duplicate or malformed quality issue page');
        seen.add(issue.id);
        issues.push(issue);
      }
      if (issues.length > total || (batch.hasMore && batch.issues.length === 0)) {
        throw new BadRequestException('Incomplete quality issue pagination');
      }
      if (!batch.hasMore) break;
      if (issues.length >= total) {
        throw new BadRequestException('Quality provider pagination limit reached; no partial snapshot was created');
      }
      page += 1;
    }
    if (issues.length !== total) throw new BadRequestException('Issue download does not match the provider total');
    const severityCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    for (const issue of issues) {
      severityCounts[issue.severity] = (severityCounts[issue.severity] ?? 0) + 1;
      if (issue.type) typeCounts[issue.type] = (typeCounts[issue.type] ?? 0) + 1;
    }
    return { issues, total, page, pageSize, hasMore: false, severityCounts, typeCounts };
  }

  async getIssueContext(
    projectId: string,
    issueId: string,
  ): Promise<QualityIssueContext> {
    const issue = await this.getIssue(projectId, issueId);
    return this.issueContext.resolve(projectId, issue);
  }

  listSnapshots(projectId: string): QualitySnapshotSummaryView[] {
    this.requireProject(projectId);
    return this.snapshots.listByProjectId(projectId).map((snapshot) => {
      const issues = this.snapshots.listIssues(snapshot.id);
      const statusCounts: Record<string, number> = {};
      let resolvedIssues = 0;
      for (const issue of issues) {
        const status = String(issue.status ?? 'UNKNOWN').toUpperCase();
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        if (isResolvedQualityStatus(status)) resolvedIssues += 1;
      }
      return {
        ...snapshot,
        openIssues: Math.max(0, issues.length - resolvedIssues),
        resolvedIssues,
        statusCounts,
      };
    });
  }

  getIssueReport(projectId: string, issueId: string) {
    const project = this.requireProject(projectId);
    const snapshots = this.snapshots.listByProjectId(projectId);
    const occurrences = snapshots.flatMap((snapshot) => {
      const issue = this.snapshots.listIssues(snapshot.id).find((item) => item.id === issueId);
      return issue ? [{ snapshot, issue }] : [];
    });
    if (!occurrences.length) {
      throw new NotFoundException(`El hallazgo no existe en los snapshots guardados: ${issueId}`);
    }

    const latestSnapshot = snapshots[0] ?? null;
    const latestOccurrence = occurrences[0];
    const issueInLatest = latestSnapshot
      ? this.snapshots.listIssues(latestSnapshot.id).find((item) => item.id === issueId)
      : undefined;
    const proposals = this.proposals.list(projectId, issueId);
    const applications = proposals.flatMap((proposal) =>
      this.fixApplications.listByProposalId(proposal.id),
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const successfulApplication = applications.find((application) =>
      application.status === 'completed' || application.status === 'review_required',
    );
    const resolved = issueInLatest
      ? isResolvedQualityStatus(issueInLatest.status)
      : Boolean(latestSnapshot && latestSnapshot.createdAt >= latestOccurrence.snapshot.createdAt);

    return {
      generatedAt: new Date().toISOString(),
      source: 'sqlite',
      generatedWithAI: false,
      project: {
        id: project.id,
        name: project.name,
        path: project.path,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      issue: issueInLatest ?? latestOccurrence.issue,
      resolution: {
        resolved,
        currentStatus: issueInLatest?.status ?? (resolved ? 'RESOLVED' : latestOccurrence.issue.status ?? 'UNKNOWN'),
        problem: latestOccurrence.issue.message,
        solution: successfulApplication
          ? proposals.find((proposal) => proposal.id === successfulApplication.proposalId)?.summary
            ?? 'La corrección registrada fue aplicada y validada por la plataforma.'
          : null,
        firstSeenAt: occurrences.at(-1)?.snapshot.createdAt ?? latestOccurrence.snapshot.createdAt,
        lastSeenAt: latestOccurrence.snapshot.createdAt,
        latestSnapshotId: latestSnapshot?.id ?? null,
      },
      snapshotHistory: occurrences.map(({ snapshot, issue }) => ({
        snapshotId: snapshot.id,
        snapshotCreatedAt: snapshot.createdAt,
        snapshotTotalIssues: snapshot.totalIssues,
        status: issue.status ?? null,
        severity: issue.severity,
        updateDate: issue.updateDate ?? null,
      })),
      proposals,
      applications,
    };
  }

  getSnapshot(
    projectId: string,
    snapshotId: string,
  ): { snapshot: QualitySnapshotRecord; issues: QualityIssue[] } {
    this.requireProject(projectId);
    const snapshot = this.snapshots.findById(snapshotId);
    if (!snapshot || snapshot.projectId !== projectId) {
      throw new NotFoundException(`Snapshot no encontrado: ${snapshotId}`);
    }
    return {
      snapshot,
      issues: this.snapshots.listIssues(snapshotId),
    };
  }

  /**
   * Used by pipeline Download/Create steps.
   * Persists a complete, independently downloaded issue set.
   */
  async createSnapshotFromProvider(
    projectId: string,
  ): Promise<QualitySnapshotRecord> {
    this.requireProject(projectId);
    const config = this.resolveProviderConfig(projectId);
    if (!config.projectKey) {
      throw new BadRequestException('Project key de calidad no configurado');
    }

    const page = await this.getAllIssues(projectId);

    return this.snapshots.create({
      projectId,
      provider: this.quality.name,
      totalIssues: page.total,
      severityCounts: page.severityCounts ?? {},
      typeCounts: page.typeCounts ?? {},
      issues: page.issues,
    });
  }

  resolveProviderConfig(projectId: string): QualityProviderConfig {
    const resolved = this.resolveConfig(projectId);
    return {
      baseUrl: resolved.baseUrl,
      projectKey: resolved.projectKey,
      projectName: resolved.projectName,
      authToken: resolved.authToken,
      credentialRef: {
        source: 'env',
        ref: 'SONAR_TOKEN',
      },
    };
  }

  private suggestProjectKey(
    projectPath: string,
    existingKey: string | undefined,
  ): string | null {
    // Do not overwrite what the user already saved — suggestion is informational.
    if (existingKey && existingKey.trim()) {
      return existingKey.trim();
    }
    const fromProps = readExistingSonarProperties(projectPath).projectKey;
    if (fromProps) {
      return fromProps;
    }
    const dirName = path.basename(projectPath.replace(/[\\/]+$/, ''));
    return dirName || null;
  }

  private deriveProjectState(
    stored: ReturnType<ProjectQualityConfigRepository['findByProjectId']>,
    connectionStatus: string | null,
  ): QualityProjectState {
    if (!stored?.projectKey?.trim()) {
      return 'not_configured';
    }
    if (connectionStatus === 'CONNECTED' || connectionStatus === 'PROJECT_EXISTS') {
      return 'project_ready';
    }
    if (connectionStatus === 'PROJECT_NOT_FOUND') {
      return 'project_missing';
    }
    if (
      connectionStatus === 'AUTHENTICATION_FAILED' ||
      connectionStatus === 'FORBIDDEN' ||
      connectionStatus === 'CREATE_FORBIDDEN' ||
      connectionStatus === 'SERVER_UNAVAILABLE' ||
      connectionStatus === 'TIMEOUT' ||
      connectionStatus === 'UNKNOWN_ERROR'
    ) {
      return 'failed';
    }
    return 'configured';
  }

  private resolveConfig(projectId: string): {
    baseUrl: string;
    projectKey: string;
    projectName: string | undefined;
    authToken: string | undefined;
    authenticationConfigured: boolean;
    baseUrlSource: 'project' | 'global' | 'none';
  } {
    const stored = this.configs.findByProjectId(projectId);
    const built = buildQualityProviderConfig(stored);
    const override = stored?.baseUrlOverride?.trim() ?? '';
    const globalUrl = loadConfig().quality.sonarUrl.trim();
    let baseUrlSource: 'project' | 'global' | 'none' = 'none';
    if (override) {
      baseUrlSource = 'project';
    } else if (globalUrl) {
      baseUrlSource = 'global';
    }
    return {
      baseUrl: built.baseUrl,
      projectKey: built.projectKey,
      projectName: built.projectName,
      authToken: built.authToken,
      authenticationConfigured: built.authenticationConfigured,
      baseUrlSource,
    };
  }

  private requireProject(projectId: string) {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
    return project;
  }

  private mapProviderError(err: unknown): Error {
    if (err instanceof QualityProviderError) {
      switch (err.status) {
        case 'SERVER_UNAVAILABLE':
          return new ServiceUnavailableException(
            'Servidor de calidad no disponible',
          );
        case 'AUTHENTICATION_FAILED':
          return new UnauthorizedException(
            'Autenticación de calidad fallida',
          );
        case 'FORBIDDEN':
        case 'CREATE_FORBIDDEN':
          return new ForbiddenException(
            'Sin permiso para el proyecto de calidad',
          );
        case 'TIMEOUT':
          return new GatewayTimeoutException(
            'Tiempo de espera agotado al consultar calidad',
          );
        case 'PROJECT_NOT_FOUND':
          return new NotFoundException('Proyecto de calidad no encontrado');
        default:
          return new BadRequestException(
            'Respuesta inválida del proveedor de calidad',
          );
      }
    }
    const message = err instanceof Error ? err.message : 'Error de calidad';
    return new BadRequestException(message);
  }
}

function isResolvedQualityStatus(status: string | undefined): boolean {
  return new Set(['CLOSED', 'RESOLVED']).has(String(status ?? '').toUpperCase());
}
