import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { QualityService } from '../../quality/quality.service';

@Injectable()
export class LoadQualityIssueStep implements PipelineStep {
  readonly id = 'load-quality-issue';
  readonly name = 'Load Quality Issue';
  constructor(private readonly quality: QualityService) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const issueId = context.data.get('agent.issueId');
    try {
      if (typeof issueId !== 'string' || !issueId) throw new Error('Quality issue id is required');
      const issue = await this.quality.getIssue(context.project.id, issueId);
      context.data.set('agent.issue', issue);
      return done(this.id, started, { issueId: issue.id, provider: issue.provider });
    } catch (error) {
      return failed(this.id, started, error);
    }
  }
}

function done(stepId: string, started: Date, result: unknown): PipelineStepResult {
  const finished = new Date();
  return { stepId, status: 'success', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result };
}
function failed(stepId: string, started: Date, error: unknown): PipelineStepResult {
  const finished = new Date();
  return { stepId, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error: error instanceof Error ? error.message : String(error) };
}
