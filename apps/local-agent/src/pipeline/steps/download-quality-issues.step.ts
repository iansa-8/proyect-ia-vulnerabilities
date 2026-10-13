import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { QualityService } from '../../quality/quality.service';

/**
 * Downloads every issues page through QualityService/QualityProvider.
 * Does not pull thousands of issue payloads when facets/paging expose totals.
 */
@Injectable()
export class DownloadQualityIssuesStep implements PipelineStep {
  readonly id = 'download-quality-issues';
  readonly name = 'Download Issues';

  constructor(private readonly quality: QualityService) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    const connection = context.data.get('quality.connection') as
      | { status?: string }
      | undefined;
    if (connection && connection.status && connection.status !== 'CONNECTED') {
      const finished = new Date();
      const detail =
        connection.status === 'PROJECT_NOT_FOUND'
          ? 'Proyecto de calidad no encontrado — crea el proyecto o ejecuta Sonar Baseline'
          : 'Quality provider not connected — download skipped';
      return {
        stepId: this.id,
        status: 'failed',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: detail,
      };
    }

    try {
      const page = await this.quality.getAllIssues(context.project.id);
      context.data.set('quality.issuesPage', {
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        hasMore: page.hasMore,
        issueCount: page.issues.length,
        severityCounts: page.severityCounts ?? {},
        typeCounts: page.typeCounts ?? {},
        issues: page.issues,
      });

      const finished = new Date();
      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: {
          total: page.total,
          downloaded: page.issues.length,
          pages: page.page,
          pageSize: page.pageSize,
          hasMore: page.hasMore,
          severityCounts: page.severityCounts ?? {},
          typeCounts: page.typeCounts ?? {},
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
