import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import type { QualityAnalyzerRegistry } from '@amp/providers';
import { QUALITY_ANALYZER_REGISTRY } from '../../providers/tokens';

/**
 * Verifies a QualityAnalyzer is available for the project profile (scanner health).
 */
@Injectable()
export class CheckQualityAnalyzerStep implements PipelineStep {
  readonly id = 'check-quality-analyzer';
  readonly name = 'Check Quality Analyzer';

  constructor(
    @Inject(QUALITY_ANALYZER_REGISTRY)
    private readonly registry: QualityAnalyzerRegistry,
  ) {}

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

      const health = await analyzer.health();
      context.data.set('quality.analyzer', {
        name: analyzer.name,
        available: health.available,
        version: health.version,
        command: health.command,
      });

      if (!health.available) {
        const finished = new Date();
        return {
          stepId: this.id,
          status: 'failed',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          error: health.error ?? 'Scanner no disponible',
          result: {
            analyzer: analyzer.name,
            available: false,
            command: health.command,
          },
        };
      }

      const finished = new Date();
      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: {
          analyzer: analyzer.name,
          available: true,
          version: health.version,
          command: health.command,
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
