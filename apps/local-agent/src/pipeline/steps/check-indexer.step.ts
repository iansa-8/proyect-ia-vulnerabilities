import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import type { IndexerProvider } from '@amp/providers';
import { INDEXER_PROVIDER } from '../../providers/tokens';

/**
 * Verifies the indexer CLI/provider is available before indexing.
 * Does not know about Codebase Memory specifics — only IndexerProvider.health().
 */
@Injectable()
export class CheckIndexerStep implements PipelineStep {
  readonly id = 'check-indexer';
  readonly name = 'Check Indexer';

  constructor(
    @Inject(INDEXER_PROVIDER) private readonly indexer: IndexerProvider,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    try {
      const health = await this.indexer.health();
      context.data.set('indexerHealth', health);

      if (!health.cliAvailable) {
        const finished = new Date();
        return {
          stepId: this.id,
          status: 'failed',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          error:
            health.error ??
            `Indexer CLI no disponible (provider=${health.provider})`,
          result: {
            provider: health.provider,
            cliAvailable: health.cliAvailable,
            uiAvailable: health.uiAvailable,
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
          provider: health.provider,
          cliAvailable: health.cliAvailable,
          uiAvailable: health.uiAvailable,
          version: health.version,
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
