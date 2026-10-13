/**
 * Neutral quality domain models.
 * Not coupled to Sonar or any vendor wire types.
 */

import type { ProjectProfile } from './project';

/** Vendor-agnostic severity label as returned/normalized by a QualityProvider. */
export type QualitySeverity = string;

export const QUALITY_CONNECTION_STATUSES = [
  'CONNECTED',
  'PROJECT_EXISTS',
  'PROJECT_NOT_FOUND',
  'CREATE_FORBIDDEN',
  'SERVER_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'FORBIDDEN',
  'TIMEOUT',
  'UNKNOWN_ERROR',
] as const;

export type QualityConnectionStatus =
  (typeof QUALITY_CONNECTION_STATUSES)[number];

export function isQualityConnectionStatus(
  value: string,
): value is QualityConnectionStatus {
  return (QUALITY_CONNECTION_STATUSES as readonly string[]).includes(value);
}

/**
 * How the backend resolves credentials for a quality call.
 * Never carries the secret value into UI/DTO responses.
 */
export type QualityCredentialSource = 'env' | 'connection';

export interface QualityCredentialRef {
  source: QualityCredentialSource;
  /** Env var name or connection id — not the secret. */
  ref: string;
}

/**
 * Runtime config passed to QualityProvider methods.
 * `authToken` is resolved server-side for the call only — never persisted or returned to clients.
 */
export interface QualityProviderConfig {
  baseUrl: string;
  projectKey: string;
  authToken?: string;
  credentialRef?: QualityCredentialRef;
  /** Display name used when provisioning a remote quality project. */
  projectName?: string;
}

export interface QualityProviderHealth {
  provider: string;
  online: boolean;
  version?: string;
  serverId?: string;
  error?: string;
  connectionStatus?: QualityConnectionStatus;
}

export interface QualityProject {
  provider: string;
  key: string;
  name: string;
}

export interface QualityIssue {
  id: string;
  provider: string;
  rule: string;
  /** Original severity string from the provider (e.g. BLOCKER, CRITICAL). */
  severity: QualitySeverity;
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

export interface QualityIssueFilters {
  severity?: string;
  type?: string;
  status?: string;
  rule?: string;
  file?: string;
  /** Free-text search over message/rule/file (provider-dependent). */
  search?: string;
}

export interface GetQualityIssuesInput {
  config: QualityProviderConfig;
  page?: number;
  pageSize?: number;
  filters?: QualityIssueFilters;
}

export interface GetQualityIssuesResult {
  issues: QualityIssue[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** Real severity counts when the provider returns facets/aggregates. */
  severityCounts?: Record<string, number>;
  typeCounts?: Record<string, number>;
}

export interface GetQualityIssueInput {
  config: QualityProviderConfig;
  issueId: string;
}

export interface QualityConnectionTestResult {
  status: QualityConnectionStatus;
  provider: string;
  project?: QualityProject;
  version?: string;
  message?: string;
  /** True when a credential was available to attempt auth — never the value. */
  authenticationConfigured: boolean;
}

export interface QualitySnapshotSummary {
  id: string;
  projectId: string;
  provider: string;
  createdAt: string;
  totalIssues: number;
  severityCounts: Record<string, number>;
  typeCounts?: Record<string, number>;
}

/** Centralized project readiness for quality analysis flows. */
export const QUALITY_PROJECT_STATES = [
  'not_configured',
  'configured',
  'project_missing',
  'project_ready',
  'analysis_pending',
  'analysis_processing',
  'analyzed',
  'failed',
] as const;

export type QualityProjectState = (typeof QUALITY_PROJECT_STATES)[number];

/**
 * Normalized analysis processing status (vendor CE statuses mapped in providers).
 */
export const QUALITY_PROCESSING_STATUSES = [
  'pending',
  'in_progress',
  'success',
  'failed',
  'timeout',
] as const;

export type QualityProcessingStatus =
  (typeof QUALITY_PROCESSING_STATUSES)[number];

export interface QualityEnsureProjectInput {
  config: QualityProviderConfig;
  /** When false, missing projects are reported as PROJECT_NOT_FOUND without create. */
  autoCreate: boolean;
  projectName?: string;
}

export interface QualityEnsureProjectResult {
  status: QualityConnectionStatus;
  provider: string;
  project?: QualityProject;
  /** True when this call created the project (not when it already existed). */
  created: boolean;
  message?: string;
  createdAt?: string;
}

export interface QualityCreateProjectInput {
  config: QualityProviderConfig;
  projectName: string;
}

export interface QualityCreateProjectResult {
  status: QualityConnectionStatus;
  provider: string;
  project?: QualityProject;
  created: boolean;
  message?: string;
  createdAt?: string;
}

export interface QualityAnalysisTaskRef {
  taskId: string;
  analysisId?: string;
  status: QualityProcessingStatus;
  /** Vendor raw status kept only for debugging metadata — prefer `status`. */
  vendorStatus?: string;
  submittedAt?: string;
  executedAt?: string;
  errorMessage?: string;
}

export interface GetQualityAnalysisTaskInput {
  config: QualityProviderConfig;
  taskId: string;
}

export interface GetQualityAnalysisActivityInput {
  config: QualityProviderConfig;
  /** Prefer the most recent task for this project key. */
  onlyCurrents?: boolean;
}

/**
 * Local quality analysis contract.
 * Pipeline Engine resolves analyzers via registry — never NodeSonarAnalyzer by name.
 */
export interface QualityAnalysisInput {
  projectId: string;
  projectPath: string;
  projectProfile: ProjectProfile;
  qualityConfig: QualityProviderConfig;
}

export interface QualityAnalysisResult {
  success: boolean;
  provider: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  analysisId?: string;
  taskId?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface QualityAnalyzerHealth {
  available: boolean;
  analyzer: string;
  version?: string;
  command?: string;
  error?: string;
}

export interface QualityAnalyzer {
  readonly name: string;
  supports(profile: ProjectProfile): boolean;
  health(): Promise<QualityAnalyzerHealth>;
  analyze(input: QualityAnalysisInput): Promise<QualityAnalysisResult>;
}
