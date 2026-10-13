import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentCodeContext, AgentTask, PipelineContext, PipelineStep, PipelineStepResult, QualityIssue } from '@amp/core';
import type { IndexContextResult, LLMProvider } from '@amp/providers';
import { LLM_PROVIDER } from '../../providers/tokens';
import type { QualityIssueContext } from '../../quality/quality-issue-context.service';
import { RemediationRouter } from '../../remediation/remediation-router.service';
import { IssueContextPolicy } from '../../remediation/issue-context-policy.service';
import { DeterministicRemediator } from '../../remediation/deterministic-remediator.service';

@Injectable()
export class ProposeFixStep implements PipelineStep {
  readonly id = 'propose-fix';
  readonly name = 'Propose Fix';
  private readonly logger = new Logger(ProposeFixStep.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly router: RemediationRouter,
    private readonly contextPolicy: IssueContextPolicy,
    private readonly local: DeterministicRemediator,
  ) { }

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const issue = context.data.get('agent.issue') as QualityIssue | undefined;
    const issueContext = context.data.get('agent.issueContext') as QualityIssueContext | undefined;

    this.logger.log(`[ProposeFixStep] Starting for issue=${issue?.id} rule=${issue?.rule} file=${issue?.file}:${issue?.line}`);

    if (!issue || !issueContext?.codeContext) {
      this.logger.warn('[ProposeFixStep] CONTEXT_UNAVAILABLE - missing issue or codeContext');
      return fail(this.id, started, 'CONTEXT_UNAVAILABLE');
    }

    this.logger.debug(`[ProposeFixStep] Getting raw context from indexer...`);
    const rawContext = toAgentContext(
      issueContext.codeContext,
      issueContext.warnings,
      issueContext.indexProvider,
      issueContext.indexState,
      context.project.path,
      issue.file,
    );
    this.logger.debug(`[ProposeFixStep] Raw context: files=${rawContext.files?.length} snippets=${rawContext.snippets?.length} symbols=${rawContext.symbols?.length} targetSymbol=${rawContext.targetSymbol}`);

    this.logger.debug(`[ProposeFixStep] Applying context budget policy...`);
    const bounded = this.contextPolicy.reduce(rawContext);
    this.logger.debug(`[ProposeFixStep] Bounded context: files=${bounded.context.files?.length} snippets=${bounded.context.snippets?.length} estimatedTokens=${bounded.estimatedInputTokens} warnings=${bounded.warnings?.join('; ')}`);

    this.logger.log(`[ProposeFixStep] Routing decision for rule=${issue.rule}...`);
    const routedDecision = this.router.decide({ issue, projectProfile: context.projectProfile, context: bounded.context });
    const forceAI = context.data.get('remediation.forceAI') === true;
    const decision = forceAI
      ? {
          strategy: 'llm' as const,
          reason: 'El desarrollador solicitó explícitamente una propuesta generada por IA.',
          confidence: routedDecision.confidence,
        }
      : routedDecision;
    context.data.set('remediation.decision', decision);
    this.logger.log(`[ProposeFixStep] Routing decision: strategy=${decision.strategy} forcedAI=${forceAI} reason=${decision.reason} confidence=${decision.confidence}`);

    if (decision.strategy === 'manual') {
      this.logger.warn(`[ProposeFixStep] MANUAL_REVIEW_REQUIRED: ${decision.reason}`);
      return fail(this.id, started, 'MANUAL_REVIEW_REQUIRED', decision.reason, { decision });
    }

    const task: AgentTask = {
      id: randomUUID(),
      type: 'propose-fix',
      projectPath: context.project.path,
      project: { id: context.project.id, path: context.project.path, runtime: context.projectProfile.runtime, framework: context.projectProfile.framework },
      issue: { provider: issue.provider, id: issue.id, rule: issue.rule, severity: issue.severity, type: issue.type, message: issue.message, file: issue.file, line: issue.line },
      context: bounded.context,
      constraints: ['preserve existing behavior', 'reuse existing project structure', 'avoid new dependencies'],
      validationCommands: {
        build: context.projectProfile.buildCommand,
        unit: context.projectProfile.testCommand ?? context.projectProfile.coverageCommand,
        e2e: context.projectProfile.e2eCommand,
        startup: context.projectProfile.startCommand,
      },
    };

    this.logger.log(`[ProposeFixStep] Executing strategy=${decision.strategy} taskId=${task.id}`);

    let result;
    if (decision.strategy === 'local') {
      this.logger.log(`[ProposeFixStep] Using DeterministicRemediator for rule=${issue.rule}`);
      if (!this.local.canHandle(task)) {
        this.logger.warn('[ProposeFixStep] DeterministicRemediator cannot handle this task');
        return fail(this.id, started, 'LOCAL_REMEDIATION_UNAVAILABLE', decision.reason);
      }
      const preconditions = this.local.validatePreconditions(issue, bounded.context);
      if (!preconditions.valid) {
        this.logger.warn(`[ProposeFixStep] Preconditions failed: ${preconditions.reason}`);
        return fail(this.id, started, 'LOCAL_PRECONDITION_FAILED', preconditions.reason, { decision });
      }
      result = this.local.propose(task, decision.reason, bounded.estimatedInputTokens);
      this.logger.log(`[ProposeFixStep] Local remediation completed: success=${result.success} provider=${result.provider}`);
    } else {
      this.logger.log(`[ProposeFixStep] Checking LLM health...`);
      const health = await this.llm.health();
      this.logger.log(`[ProposeFixStep] LLM health: available=${health.available} provider=${health.provider} model=${health.model} error=${health.error}`);
      if (!health.available) {
        this.logger.error(`[ProposeFixStep] LLM unavailable: ${health.error}`);
        return fail(this.id, started, 'LLM_UNAVAILABLE', health.error, { decision, provider: health.provider, model: health.model });
      }
      this.logger.log(`[ProposeFixStep] Calling LiteLLM proposeFix...`);
      const llmStarted = Date.now();
      result = await this.llm.proposeFix(task);
      this.logger.log(`[ProposeFixStep] LiteLLM proposeFix completed in ${Date.now() - llmStarted}ms: success=${result.success} provider=${result.provider} model=${result.model} usage=${JSON.stringify(result.usage)}`);
    }

    context.data.set('agent.task', task);
    context.data.set('agent.result', result);
    this.logger.debug(`[ProposeFixStep] Provider result received: success=${result.success} hasProposal=${Boolean(result.proposal)}`);
    if (!result.success || !result.proposal) {
      this.logger.error(`[ProposeFixStep] Proposal failed: ${result.error?.code} - ${result.error?.message}`);
      return fail(this.id, started, result.error?.code ?? 'LLM_EXECUTION_FAILED', result.error?.message, { decision });
    }
    result.proposal.remediationStrategy = decision.strategy;
    result.proposal.remediationReason = decision.reason;
    result.proposal.estimatedInputTokens = result.usage?.estimatedInputTokens ?? bounded.estimatedInputTokens;
    const finished = new Date();
    this.logger.log(`[ProposeFixStep] Completed in ${finished.getTime() - started.getTime()}ms: strategy=${decision.strategy} provider=${result.provider} summary=${result.proposal.summary?.slice(0, 100)}`);
    return {
      stepId: this.id,
      status: 'success',
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      result: {
        taskId: task.id,
        provider: result.provider,
        model: result.model,
        summary: result.proposal.summary,
        affectedFiles: result.proposal.affectedFiles,
        remediationStrategy: decision.strategy,
        remediationReason: decision.reason,
        estimatedInputTokens: result.proposal.estimatedInputTokens,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      },
    };
  }
}

export function toAgentContext(code: IndexContextResult, warnings: string[], indexProvider: string | undefined, indexState: string | undefined, projectPath: string, preferredFile?: string): AgentCodeContext {
  const normalizeFile = (file: string): string => {
    if (!path.isAbsolute(file)) return file.replace(/\\/g, '/');
    const relative = path.relative(projectPath, file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative.replace(/\\/g, '/');
    return file.replace(/\\/g, '/');
  };
  const preferred = preferredFile ? normalizeFile(preferredFile) : undefined;
  const files = [
    ...(preferred ? [preferred] : []),
    ...code.relatedFiles,
    ...code.snippets.map((item) => item.filePath ?? ''),
  ].filter(Boolean).map(normalizeFile);
  return {
    indexProvider,
    indexState,
    targetSymbol: code.target?.qualifiedName ?? code.target?.name,
    files: [...new Set(files)],
    symbols: code.symbols.map((item) => item.qualifiedName ?? item.name),
    snippets: code.snippets.map((item) => ({ file: normalizeFile(item.filePath ?? ''), startLine: item.startLine, endLine: item.endLine, content: item.content })),
    callers: code.relations.filter((item) => item.kind === 'caller').map((item) => item.from),
    callees: code.relations.filter((item) => item.kind === 'callee').map((item) => item.to),
    tests: code.tests.map((item) => item.filePath ?? item.qualifiedName ?? item.name),
    warnings,
  };
}

function fail(stepId: string, started: Date, error: string, detail?: string, result?: unknown): PipelineStepResult {
  const finished = new Date();
  return { stepId, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error, result: result ?? (detail ? { detail } : undefined) };
}
