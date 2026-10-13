import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import type { QualityProvider } from '@amp/providers';
import { ProjectQualityConfigRepository } from '../../persistence/project-quality-config.repository';
import { QUALITY_PROVIDER } from '../../providers/tokens';
import { buildQualityProviderConfig } from '../../quality/quality-config.util';

/**
 * Verifies QualityProvider connectivity for the project.
 * Depends on QualityProvider — never on Sonar types/URLs outside the provider.
 */
@Injectable()
export class CheckQualityProviderStep implements PipelineStep {
  readonly id = 'check-quality-provider';
  readonly name = 'Check Quality Provider';

  constructor(
    @Inject(QUALITY_PROVIDER) private readonly quality: QualityProvider,
    private readonly configs: ProjectQualityConfigRepository,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    try {
      const stored = this.configs.findByProjectId(context.project.id);
      const config = buildQualityProviderConfig(stored);
      if (!config.projectKey.trim()) {
        throw new Error('Configure a quality project key before running the baseline');
      }
      context.data.set('quality.provider', this.quality.name);
      const result = await this.quality.testConnection(config);
      context.data.set('quality.connection', result);
      context.data.set('quality.providerConfig', {
        baseUrl: config.baseUrl,
        projectKey: config.projectKey,
        authenticationConfigured: config.authenticationConfigured,
      });

      if (result.status !== 'CONNECTED' && result.status !== 'PROJECT_NOT_FOUND') {
        const finished = new Date();
        return {
          stepId: this.id,
          status: 'failed',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          error: result.message ?? result.status,
          result: {
            status: result.status,
            authenticationConfigured: result.authenticationConfigured,
            version: result.version,
            projectKey: result.project?.key,
          },
        };
      }

      // PROJECT_NOT_FOUND is allowed here so ensure-quality-project can create.
      // quality-analysis download still fails if status is not CONNECTED.
      const finished = new Date();
      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: {
          status: result.status,
          version: result.version,
          projectKey: result.project?.key,
          projectName: result.project?.name,
          authenticationConfigured: result.authenticationConfigured,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const finished = new Date();
      return {
        stepId: this.id,
        status: 'failed',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: message,
      };
    }
  }
}
