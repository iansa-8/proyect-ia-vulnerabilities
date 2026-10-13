import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { ProjectIndexRepository } from '../../persistence/project-index.repository';

/**
 * Records code-index state for observability.
 * Does NOT fail the quality pipeline when the index is missing/stale
 * (Sonar analysis does not require READY). Never auto-reindexes.
 */
@Injectable()
export class CheckCodeIndexStep implements PipelineStep {
  readonly id = 'check-code-index';
  readonly name = 'Check Code Index';

  constructor(private readonly indexes: ProjectIndexRepository) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    const record = this.indexes.findByProjectId(context.project.id);
    const state = record?.status ?? 'not_indexed';
    context.data.set('codeIndex.state', state);
    context.data.set('codeIndex.record', record);

    let note = `Índice: ${state}`;
    if (state === 'stale') {
      note =
        'El índice de código está desactualizado. El contexto puede no coincidir con el código actual.';
    } else if (state === 'not_indexed') {
      note = 'Sin índice de código. El análisis de calidad continúa sin contexto.';
    }

    const finished = new Date();
    return {
      stepId: this.id,
      status: 'success',
      startedAt,
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      result: {
        state,
        note,
        provider: record?.provider ?? null,
      },
    };
  }
}
