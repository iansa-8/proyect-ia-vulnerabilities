import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import type { IndexerProvider } from '@amp/providers';
import { EventsGateway } from '../../events/events.gateway';
import { INDEXER_PROVIDER } from '../../providers/tokens';

/**
 * Indexes the project via IndexerProvider.
 * Pipeline Engine stays unaware of Codebase Memory / IndexerProvider internals.
 */
@Injectable()
export class IndexProjectStep implements PipelineStep {
  readonly id = 'index-project';
  readonly name = 'Index Project';

  constructor(
    @Inject(INDEXER_PROVIDER) private readonly indexer: IndexerProvider,
    private readonly events: EventsGateway,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();
    const forceReindex = context.data.get('forceReindex') === true;

    this.events.emitEvent({
      type: 'index.started',
      timestamp: startedAt,
      payload: {
        projectId: context.project.id,
        provider: this.indexer.name,
      },
    });

    try {
      const result = await this.indexer.indexProject({
        projectId: context.project.id,
        projectPath: context.project.path,
        forceReindex,
      });

      context.data.set('indexProject.result', result);

      const finished = new Date();
      if (!result.success) {
        this.events.emitEvent({
          type: 'index.failed',
          timestamp: finished.toISOString(),
          payload: {
            projectId: context.project.id,
            provider: this.indexer.name,
            error: result.error ?? 'Indexación fallida',
          },
        });
        return {
          stepId: this.id,
          status: 'failed',
          startedAt,
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - started.getTime(),
          error: result.error ?? 'Indexación fallida',
          result: {
            provider: result.provider,
            skipped: result.skipped,
          },
        };
      }

      this.events.emitEvent({
        type: 'index.completed',
        timestamp: finished.toISOString(),
        payload: {
          projectId: context.project.id,
          provider: result.provider,
          providerProjectName: result.providerProjectName,
          durationMs: result.durationMs,
          skipped: result.skipped,
        },
      });

      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: {
          provider: result.provider,
          providerProjectName: result.providerProjectName,
          indexedAt: result.indexedAt,
          durationMs: result.durationMs,
          gitCommit: result.gitCommit,
          stats: result.stats,
          skipped: result.skipped,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const finished = new Date();
      this.events.emitEvent({
        type: 'index.failed',
        timestamp: finished.toISOString(),
        payload: {
          projectId: context.project.id,
          provider: this.indexer.name,
          error: message,
        },
      });
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
