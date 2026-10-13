import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult, QualityIssue } from '@amp/core';
import { WorkingTreeGuardService } from '../../agent/working-tree-guard.service';
import type { QualityIssueContext } from '../../quality/quality-issue-context.service';
import { captureProposalFileBaseline } from './proposal-file-baseline';

@Injectable()
export class CaptureWorkingTreeBaselineStep implements PipelineStep {
  readonly id = 'capture-working-tree-baseline';
  readonly name = 'Capture Working Tree Baseline';
  constructor(private readonly guard: WorkingTreeGuardService) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    try {
      const snapshot = await this.guard.capture(context.project.path);
      context.data.set('agent.workingTreeBefore', snapshot);
      const finished = new Date();
      return { stepId: this.id, status: 'success', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result: { fingerprint: snapshot.fingerprint, dirty: Boolean(snapshot.status) } };
    } catch (error) {
      if (error instanceof Error && error.message === 'GIT_REPOSITORY_REQUIRED') {
        try {
          const issue = context.data.get('agent.issue') as QualityIssue | undefined;
          const issueContext = context.data.get('agent.issueContext') as QualityIssueContext | undefined;
          const files = [
            issue?.file,
            ...(issueContext?.codeContext?.relatedFiles ?? []),
            ...(issueContext?.codeContext?.snippets.map((item) => item.filePath ?? '') ?? []),
          ].filter((file): file is string => Boolean(file));
          const snapshot = captureProposalFileBaseline(context.project.path, files);
          context.data.set('agent.workingTreeBefore', snapshot);
          context.data.set('agent.proposalFileBaseline', true);
          const finished = new Date();
          return { stepId: this.id, status: 'success', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result: { fingerprint: snapshot.fingerprint, mode: 'context-files', files: Object.keys(snapshot.fileHashes ?? {}) } };
        } catch (fallbackError) {
          const finished = new Date();
          return { stepId: this.id, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error: fallbackError instanceof Error ? fallbackError.message : 'CONTEXT_UNAVAILABLE' };
        }
      }
      const finished = new Date();
      return { stepId: this.id, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error: error instanceof Error ? error.message : 'CONTEXT_UNAVAILABLE' };
    }
  }
}
