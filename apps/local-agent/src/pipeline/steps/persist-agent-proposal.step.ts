import { Injectable } from '@nestjs/common';
import type { AgentCodeContext, AgentResult, AgentTask, PipelineContext, PipelineStep, PipelineStepResult, QualityIssue } from '@amp/core';
import { AgentProposalRepository } from '../../persistence/agent-proposal.repository';
import type { WorkingTreeSnapshot } from '../../agent/working-tree-guard.service';

@Injectable()
export class PersistAgentProposalStep implements PipelineStep {
  readonly id = 'persist-agent-proposal';
  readonly name = 'Persist Agent Proposal';
  constructor(private readonly proposals: AgentProposalRepository) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const result = context.data.get('agent.result') as AgentResult | undefined;
    const task = context.data.get('agent.task') as AgentTask | undefined;
    const issue = context.data.get('agent.issue') as QualityIssue | undefined;
    if (!result?.proposal || !task?.id || !issue || result.writeDetection?.unchanged !== true) {
      return fail(this.id, started, 'Proposal is incomplete or repository verification failed');
    }
    try {
      const agentContext = task.context as AgentCodeContext;
      const baseline = context.data.get('agent.workingTreeBefore') as WorkingTreeSnapshot | undefined;
      const contextFileHashes = Object.fromEntries(
        agentContext.files
          .map((file) => file.replace(/\\/g, '/'))
          .filter((file) => baseline?.fileHashes?.[file])
          .map((file) => [file, baseline!.fileHashes![file]]),
      );
      const record = this.proposals.create({
        ...result.proposal,
        warnings: [
          ...(result.proposal.warnings ?? []),
          ...(context.data.get('agent.proposalFileBaseline') === true
            ? ['Proyecto sin repositorio Git: la propuesta se protegió con hashes de contexto. La aplicación automática todavía requiere un checkpoint Git.']
            : []),
        ],
        projectId: context.project.id,
        issueId: issue.id,
        providerVersion: result.providerVersion,
        durationMs: result.durationMs,
        contextFiles: agentContext.files,
        contextSizeChars: (agentContext.snippets ?? []).reduce((total, item) => total + item.content.length, 0),
        repositoryUnchanged: true,
        executionTrace: result.executionTrace,
        contextRevision: baseline?.fingerprint,
        contextFileHashes,
      });
      context.data.set('agent.proposalId', record.id);
      const finished = new Date();
      return { stepId: this.id, status: 'success', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result: record };
    } catch {
      return fail(this.id, started, 'Failed to persist proposal');
    }
  }
}
function fail(stepId: string, started: Date, error: string): PipelineStepResult {
  const finished = new Date();
  return { stepId, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error };
}
