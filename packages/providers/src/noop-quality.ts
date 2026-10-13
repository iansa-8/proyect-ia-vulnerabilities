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
import type { QualityProvider } from './quality-provider';
import { QUALITY_DEFAULT_PAGE_SIZE } from './quality-provider';

/** Placeholder quality provider — returns empty findings / not connected. */
export class NoOpQualityProvider implements QualityProvider {
  readonly name = 'noop-quality';

  async health(_config: QualityProviderConfig): Promise<QualityProviderHealth> {
    return {
      provider: this.name,
      online: false,
      connectionStatus: 'SERVER_UNAVAILABLE',
      error: 'No quality provider configured',
    };
  }

  async testConnection(
    config: QualityProviderConfig,
  ): Promise<QualityConnectionTestResult> {
    return {
      status: 'SERVER_UNAVAILABLE',
      provider: this.name,
      authenticationConfigured: Boolean(config.authToken),
      message: 'No quality provider configured',
    };
  }

  async getProject(
    _config: QualityProviderConfig,
  ): Promise<QualityProject | null> {
    return null;
  }

  async ensureProject(
    _input: QualityEnsureProjectInput,
  ): Promise<QualityEnsureProjectResult> {
    return {
      status: 'SERVER_UNAVAILABLE',
      provider: this.name,
      created: false,
      message: 'No quality provider configured',
    };
  }

  async createProject(
    _input: QualityCreateProjectInput,
  ): Promise<QualityCreateProjectResult> {
    return {
      status: 'SERVER_UNAVAILABLE',
      provider: this.name,
      created: false,
      message: 'No quality provider configured',
    };
  }

  async getIssues(
    input: GetQualityIssuesInput,
  ): Promise<GetQualityIssuesResult> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(
      QUALITY_DEFAULT_PAGE_SIZE,
      Math.max(1, input.pageSize ?? QUALITY_DEFAULT_PAGE_SIZE),
    );
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

  async getIssue(_input: GetQualityIssueInput): Promise<QualityIssue | null> {
    return null;
  }

  async getAnalysisTask(
    _input: GetQualityAnalysisTaskInput,
  ): Promise<QualityAnalysisTaskRef | null> {
    return null;
  }

  async getLatestAnalysisActivity(
    _input: GetQualityAnalysisActivityInput,
  ): Promise<QualityAnalysisTaskRef | null> {
    return null;
  }
}
