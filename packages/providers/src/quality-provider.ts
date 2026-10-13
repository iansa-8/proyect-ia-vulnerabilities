import type {
  GetQualityAnalysisActivityInput,
  GetQualityAnalysisTaskInput,
  GetQualityIssueInput,
  GetQualityIssuesInput,
  GetQualityIssuesResult,
  QualityAnalysisTaskRef,
  QualityConnectionTestResult,
  QualityCreateProjectInput,
  QualityCreateProjectResult,
  QualityEnsureProjectInput,
  QualityEnsureProjectResult,
  QualityIssue,
  QualityProject,
  QualityProviderConfig,
  QualityProviderHealth,
} from '@amp/core';

/**
 * Quality findings source (Web API).
 * Pipeline Engine depends only on this contract — never on Sonar types/URLs.
 * Does NOT execute local scanners — that is QualityAnalyzer.
 */
export interface QualityProvider {
  readonly name: string;

  health(config: QualityProviderConfig): Promise<QualityProviderHealth>;

  testConnection(
    config: QualityProviderConfig,
  ): Promise<QualityConnectionTestResult>;

  getProject(config: QualityProviderConfig): Promise<QualityProject | null>;

  /**
   * Idempotent: returns existing project, or creates when autoCreate is true.
   * Never duplicates when the key already exists.
   */
  ensureProject(
    input: QualityEnsureProjectInput,
  ): Promise<QualityEnsureProjectResult>;

  /** Explicit create (UI consent). Idempotent if key already exists. */
  createProject(
    input: QualityCreateProjectInput,
  ): Promise<QualityCreateProjectResult>;

  getIssues(input: GetQualityIssuesInput): Promise<GetQualityIssuesResult>;

  getIssue(input: GetQualityIssueInput): Promise<QualityIssue | null>;

  /** Poll Compute Engine / analysis processing by task id. */
  getAnalysisTask(
    input: GetQualityAnalysisTaskInput,
  ): Promise<QualityAnalysisTaskRef | null>;

  /** Latest analysis activity for a project key (fallback when task id unknown). */
  getLatestAnalysisActivity(
    input: GetQualityAnalysisActivityInput,
  ): Promise<QualityAnalysisTaskRef | null>;
}

/** Default / max page sizes for quality issue pagination. */
export const QUALITY_DEFAULT_PAGE_SIZE = 50;
export const QUALITY_MAX_PAGE_SIZE = 100;
