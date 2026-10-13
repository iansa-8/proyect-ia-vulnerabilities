import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { collectSecretValues, redactSecretsInText } from '@amp/core';
import type { QualityAnalyzerRegistry } from '@amp/providers';
import { ProjectQualityConfigRepository } from '../../persistence/project-quality-config.repository';
import { QUALITY_ANALYZER_REGISTRY } from '../../providers/tokens';
import { buildQualityProviderConfig } from '../../quality/quality-config.util';

/**
 * Runs local analysis via QualityAnalyzerRegistry.resolve(profile).
 * Engine never names NodeSonarAnalyzer.
 */
@Injectable()
export class RunQualityAnalysisStep implements PipelineStep {
  readonly id = 'run-quality-analysis';
  readonly name = 'Run Quality Analysis';

  constructor(
    @Inject(QUALITY_ANALYZER_REGISTRY)
    private readonly registry: QualityAnalyzerRegistry,
    private readonly configs: ProjectQualityConfigRepository,
  ) { }

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    try {
      const analyzer = this.registry.resolve(context.projectProfile);

      if (!analyzer) {
        const finished = new Date();
        return {
          stepId: this.id,
          status: 'failed',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          error: 'No hay analizador de calidad para este stack',
        };
      }

      const stored = this.configs.findByProjectId(context.project.id);
      const built = buildQualityProviderConfig(stored);
      const projectName =
        stored?.sonarProjectName?.trim() ||
        context.project.name;

      const analysis = await analyzer.analyze({
        projectId: context.project.id,
        projectPath: context.project.path,
        projectProfile: context.projectProfile,
        qualityConfig: {
          baseUrl: built.baseUrl,
          projectKey: built.projectKey,
          authToken: built.authToken,
          projectName,
          credentialRef: built.credentialRef,
        },
      });

      context.data.set('quality.analysis', {
        success: analysis.success,
        provider: analysis.provider,
        taskId: analysis.taskId,
        analysisId: analysis.analysisId,
        durationMs: analysis.durationMs,
        startedAt: analysis.startedAt,
        finishedAt: analysis.finishedAt,
        error: analysis.error,
      });


      if (analysis.taskId) {
        context.data.set('quality.taskId', analysis.taskId);
      }

      const finished = new Date();
      if (!analysis.success) {
      
        return {
          stepId: this.id,
          status: 'failed',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          error: analysis.error ?? 'Quality analysis failed',
          result: {
            provider: analysis.provider,
            taskId: analysis.taskId,
            durationMs: analysis.durationMs,
            stdout: redactSecretsInText(analysis.stdout ?? '', collectSecretValues(process.env)).slice(-12000),
            stderr: redactSecretsInText(analysis.stderr ?? '', collectSecretValues(process.env)).slice(-12000),
          },
        };
      }

      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: {
          provider: analysis.provider,
          taskId: analysis.taskId,
          analysisId: analysis.analysisId,
          durationMs: analysis.durationMs,
          stdout: redactSecretsInText(analysis.stdout ?? '', collectSecretValues(process.env)).slice(-12000),
          stderr: redactSecretsInText(analysis.stderr ?? '', collectSecretValues(process.env)).slice(-12000),
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
