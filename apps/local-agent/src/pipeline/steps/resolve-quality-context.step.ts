import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult, QualityIssue } from '@amp/core';
import { QualityIssueContextService } from '../../quality/quality-issue-context.service';

@Injectable()
export class ResolveQualityContextStep implements PipelineStep {
  readonly id = 'resolve-quality-context';
  readonly name = 'Resolve Code Context';
  constructor(private readonly contexts: QualityIssueContextService) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    try {
      const issue = context.data.get('agent.issue') as QualityIssue | undefined;
      if (!issue) throw new Error('CONTEXT_UNAVAILABLE: quality issue was not loaded');
      const resolved = await this.contexts.resolve(context.project.id, issue);
      if (!resolved.codeContext) throw new Error('CONTEXT_UNAVAILABLE: code context was not resolved');
      context.data.set('agent.issueContext', resolved);
      const files = new Set([
        issue.file,
        ...resolved.codeContext.relatedFiles,
        ...resolved.codeContext.snippets.map((item) => item.filePath ?? ''),
      ].filter(Boolean));
      return finish(this.id, started, 'success', undefined, {
        files: [...files],
        symbols: resolved.codeContext.symbols.length,
        snippets: resolved.codeContext.snippets.length,
        warnings: resolved.warnings,
      });
    } catch (error) {
      return finish(this.id, started, 'failed', error);
    }
  }
}

function finish(stepId: string, started: Date, status: 'success' | 'failed', error?: unknown, result?: unknown): PipelineStepResult {
  const finished = new Date();
  return { stepId, status, startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result, error: error ? (error instanceof Error ? error.message : String(error)) : undefined };
}
