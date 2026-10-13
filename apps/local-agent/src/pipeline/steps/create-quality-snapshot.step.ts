import { Injectable } from '@nestjs/common';
import type {
  PipelineContext,
  PipelineStep,
  PipelineStepResult,
  QualityIssue,
} from '@amp/core';
import { QualitySnapshotRepository } from '../../persistence/quality-snapshot.repository';

interface DownloadedIssuesBag {
  total: number;
  severityCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  issues: QualityIssue[];
}

/**
 * Persists a QualitySnapshot from the downloaded page + facet totals.
 * Stores the complete downloaded issue set and aggregate counts atomically.
 * Never stores raw HTTP JSON or tokens.
 */
@Injectable()
export class CreateQualitySnapshotStep implements PipelineStep {
  readonly id = 'create-quality-snapshot';
  readonly name = 'Create Quality Snapshot';

  constructor(private readonly snapshots: QualitySnapshotRepository) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    const bag = context.data.get('quality.issuesPage') as
      | DownloadedIssuesBag
      | undefined;
    if (!bag) {
      const finished = new Date();
      return {
        stepId: this.id,
        status: 'failed',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: 'No downloaded issues in pipeline context',
      };
    }

    try {
      if (bag.issues.length !== bag.total) throw new Error('Cannot snapshot an incomplete issue download');
      const provider =
        bag.issues[0]?.provider ??
        String(context.data.get('quality.provider') ?? 'sonar');

      const snapshot = this.snapshots.create({
        projectId: context.project.id,
        provider,
        totalIssues: bag.total,
        severityCounts: bag.severityCounts ?? {},
        typeCounts: bag.typeCounts ?? {},
        issues: bag.issues,
      });
      context.data.set('quality.snapshotId', snapshot.id);

      const finished = new Date();
      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: {
          snapshotId: snapshot.id,
          totalIssues: snapshot.totalIssues,
          persistedIssues: bag.issues.length,
          createdAt: snapshot.createdAt,
          typeCounts: snapshot.typeCounts,
          severityCounts: snapshot.severityCounts,
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
