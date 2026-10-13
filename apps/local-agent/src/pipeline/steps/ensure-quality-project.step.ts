import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import type { QualityProvider } from '@amp/providers';
import { ProjectQualityConfigRepository } from '../../persistence/project-quality-config.repository';
import { QUALITY_PROVIDER } from '../../providers/tokens';
import { buildQualityProviderConfig } from '../../quality/quality-config.util';

/**
 * Ensures the remote quality project exists (idempotent).
 * Uses QualityProvider — never calls Sonar HTTP directly.
 * Stops the pipeline when missing and autoCreate is false.
 */
@Injectable()
export class EnsureQualityProjectStep implements PipelineStep {
  readonly id = 'ensure-quality-project';
  readonly name = 'Ensure Quality Project';

  constructor(
    @Inject(QUALITY_PROVIDER) private readonly quality: QualityProvider,
    private readonly configs: ProjectQualityConfigRepository,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    try {
      const stored = this.configs.findByProjectId(context.project.id);
      const built = buildQualityProviderConfig(stored);
      const autoCreate = stored?.autoCreateProject ?? false;
      const projectName =
        stored?.sonarProjectName?.trim() ||
        built.projectName ||
        context.project.name;

      const result = await this.quality.ensureProject({
        config: {
          baseUrl: built.baseUrl,
          projectKey: built.projectKey,
          authToken: built.authToken,
          projectName,
          credentialRef: built.credentialRef,
        },
        autoCreate,
        projectName,
      });

      context.data.set('quality.ensure', {
        status: result.status,
        created: result.created,
        projectKey: result.project?.key,
        projectName: result.project?.name,
        createdAt: result.createdAt,
      });

      if (
        result.status === 'PROJECT_EXISTS' ||
        result.status === 'CONNECTED' ||
        (result.project && result.status !== 'PROJECT_NOT_FOUND')
      ) {
        // Refresh connection bag so later download steps see CONNECTED.
        context.data.set('quality.connection', {
          status: 'CONNECTED',
          provider: result.provider,
          project: result.project,
          authenticationConfigured: built.authenticationConfigured,
          message: result.message,
        });

        const finished = new Date();
        return {
          stepId: this.id,
          status: 'success',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          result: {
            status: result.status,
            created: result.created,
            projectKey: result.project?.key,
            projectName: result.project?.name,
          },
        };
      }

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
          created: result.created,
          autoCreate,
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
