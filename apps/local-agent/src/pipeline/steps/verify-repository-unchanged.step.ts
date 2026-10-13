import { Injectable } from '@nestjs/common';
import type { AgentResult, PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { WorkingTreeGuardService, type WorkingTreeSnapshot } from '../../agent/working-tree-guard.service';
import { captureProposalFileBaseline } from './proposal-file-baseline';

@Injectable()
export class VerifyRepositoryUnchangedStep implements PipelineStep {
  readonly id = 'verify-repository-unchanged';
  readonly name = 'Verify Repository Unchanged';
  constructor(private readonly guard: WorkingTreeGuardService) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    try {
      const before = context.data.get('agent.workingTreeBefore') as WorkingTreeSnapshot | undefined;
      if (!before) throw new Error('CONTEXT_UNAVAILABLE');
      const fileBaseline = context.data.get('agent.proposalFileBaseline') === true;
      const after = fileBaseline
        ? captureProposalFileBaseline(context.project.path, Object.keys(before.fileHashes ?? {}))
        : await this.guard.capture(context.project.path);
      const unchanged = fileBaseline ? before.fingerprint === after.fingerprint : this.guard.unchanged(before, after);
      const agentResult = context.data.get('agent.result') as AgentResult | undefined;
      if (agentResult) {
        agentResult.writeDetection = {
          unchanged,
          beforeFingerprint: before.fingerprint,
          afterFingerprint: after.fingerprint,
        };
      }
      const finished = new Date();
      return {
        stepId: this.id,
        status: unchanged ? 'success' : 'failed',
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: { unchanged, beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint, mode: fileBaseline ? 'context-files' : 'git' },
        error: unchanged ? undefined : 'AGENT_WRITE_DETECTED',
      };
    } catch (error) {
      const finished = new Date();
      return { stepId: this.id, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error: error instanceof Error ? error.message : String(error) };
    }
  }
}
