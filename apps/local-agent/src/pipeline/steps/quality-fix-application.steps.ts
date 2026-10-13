import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentTask, PipelineContext, PipelineStep, PipelineStepResult, QualityIssue } from '@amp/core';
import type { AgentProvider } from '@amp/providers';
import { GitSafetyService, type GitChangeSet, type GitSafetySnapshot } from '../../agent/git-safety.service';
import { AgentProposalRepository, type AgentProposalRecord } from '../../persistence/agent-proposal.repository';
import { FixApplicationRepository, type FixApplicationReport, type FixApplicationStatus } from '../../persistence/fix-application.repository';
import { QualitySnapshotRepository, type QualitySnapshotRecord } from '../../persistence/quality-snapshot.repository';
import type { QualityIssueContext } from '../../quality/quality-issue-context.service';
import { AGENT_PROVIDER } from '../../providers/tokens';
import { toAgentContext } from './propose-fix.step';
import { StructuredPatchEngine } from '../../remediation/structured-patch.engine';
import { IssueContextPolicy } from '../../remediation/issue-context-policy.service';
import { loadConfig } from '../../config/app-config';

const SENSITIVE_PATH = /(^|\/)(node_modules(?:\/|$)|\.env(?:\..*)?|credentials?|secrets?|.*\.(?:pem|key|p12|pfx)|service[-_.]?account.*|\.git(?:\/|$)|\.github\/workflows\/.*credentials?)/i;

@Injectable()
export class LoadApprovedProposalStep implements PipelineStep {
  readonly id = 'load-approved-proposal'; readonly name = 'Load Approved Proposal';
  constructor(
    private readonly proposals: AgentProposalRepository,
    private readonly snapshots: QualitySnapshotRepository,
    private readonly reports: FixApplicationRepository,
  ) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const proposalId = String(context.data.get('fix.proposalId') ?? '');
    const approvedBy = String(context.data.get('fix.approvedBy') ?? 'local-developer');
    const proposal = this.proposals.findById(proposalId);
    if (!proposal || proposal.projectId !== context.project.id) return fail(this.id, started, 'APPROVED_PROPOSAL_NOT_FOUND');
    if (proposal.status === 'rejected') return fail(this.id, started, 'PROPOSAL_REJECTED');
    const approved = this.proposals.markApproved(proposal.id, approvedBy);
    if (!approved) return fail(this.id, started, 'PROPOSAL_APPROVAL_TRANSITION_FAILED');
    context.data.set('fix.proposal', approved);
    context.data.set('agent.issueId', approved.issueId);
    const before = this.snapshots.listByProjectId(context.project.id)[0];
    if (!before) return fail(this.id, started, 'QUALITY_BASELINE_REQUIRED');
    context.data.set('fix.beforeSnapshot', before);
    context.data.set('fix.approvedAt', approved.approvedAt ?? new Date().toISOString());
    this.reports.upsert(reportInput(context, 'approved', { proposal: summarizeProposal(approved), qualityBefore: before }));
    return done(this.id, started, { proposalId, issueId: approved.issueId, approvedBy, approvedAt: approved.approvedAt, beforeSnapshotId: before.id });
  }
}

@Injectable()
export class ValidateApprovedProposalStep implements PipelineStep {
  readonly id = 'validate-approved-proposal'; readonly name = 'Validate Proposal';
  constructor(private readonly safety: GitSafetyService) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const proposal = context.data.get('fix.proposal') as AgentProposalRecord | undefined;
    if (!proposal?.affectedFiles.length) return fail(this.id, started, 'INVALID_APPROVED_PROPOSAL');
    const allowed = proposal.affectedFiles.map(normalizeFile);
    if (allowed.some((file) => SENSITIVE_PATH.test(file))) return fail(this.id, started, 'SENSITIVE_FILE_CHANGE_FORBIDDEN');
    const patchFiles = [
      ...(proposal.patch?.edits ?? []).map((edit) => normalizeFile(edit.file)),
      ...(proposal.patch?.preconditions ?? []).map((precondition) => normalizeFile(precondition.file)),
    ];
    if (patchFiles.some((file) => !allowed.includes(file))) {
      return fail(this.id, started, 'PATCH_FILES_OUTSIDE_SCOPE');
    }
    if (context.data.get('codeIndex.state') !== 'ready') return fail(this.id, started, 'PROPOSAL_STALE: code index is not ready');
    if (!proposal.contextRevision) return fail(this.id, started, 'PROPOSAL_STALE: proposal has no context revision');
    if (!Object.keys(proposal.contextFileHashes ?? {}).length) return fail(this.id, started, 'PROPOSAL_STALE: proposal has no context hashes');
    const current = await this.safety.capture(context.project.path);
    const fileBaselineProposal = (proposal.warnings ?? []).some((warning) => warning.includes('sin repositorio Git'));
    if (current.fingerprint !== proposal.contextRevision && !fileBaselineProposal) {
      return fail(this.id, started, 'PROPOSAL_STALE: repository working tree changed');
    }
    for (const [file, expected] of Object.entries(proposal.contextFileHashes)) {
      if (current.fileHashes[normalizeFile(file)] !== expected) return fail(this.id, started, `PROPOSAL_STALE: ${normalizeFile(file)} changed`);
    }
    context.data.set('fix.allowedFiles', allowed);
    return done(this.id, started, {
      allowedFiles: allowed,
      contextRevision: proposal.contextRevision,
      validationMode: fileBaselineProposal ? 'context-file-hashes' : 'git-fingerprint',
    });
  }
}

@Injectable()
export class CaptureGitBaselineStep implements PipelineStep {
  readonly id = 'capture-git-baseline'; readonly name = 'Git Baseline';
  constructor(private readonly safety: GitSafetyService) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    try {
      const baseline = await this.safety.capture(context.project.path);
      context.data.set('fix.gitBaseline', baseline);
      return done(this.id, started, {
        fingerprint: baseline.fingerprint,
        dirty: Boolean(baseline.status.trim()),
        preExistingChangedFiles: statusFiles(baseline.status),
      });
    } catch (error) { return fail(this.id, started, message(error)); }
  }
}

@Injectable()
export class CheckApplyAgentProviderStep implements PipelineStep {
  readonly id = 'check-apply-agent-provider'; readonly name = 'Check Apply Agent';
  private readonly logger = new Logger(CheckApplyAgentProviderStep.name);
  constructor(@Inject(AGENT_PROVIDER) private readonly agent: AgentProvider) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const proposal = context.data.get('fix.proposal') as AgentProposalRecord | undefined;
    const forceAgent = context.data.get('fix.forceAgent') === true;
    this.logger.log(`[CheckApplyAgent] proposalId=${proposal?.id} requiresAgent=${proposal?.requiresAgent} forceAgent=${forceAgent} strategy=${proposal?.remediationStrategy} agent=${this.agent.name}`);
    
    // If the proposal requires agent escalation, route to agent provider
    if (proposal?.requiresAgent || forceAgent) {
      const reason = forceAgent
        ? 'El desarrollador solicitó explícitamente aplicar la propuesta con IA.'
        : proposal?.escalationReason;
      this.logger.log(`[CheckApplyAgent] routing to ${this.agent.name}, escalationReason=${reason?.slice(0,100)}`);
      const healthResult = await this.agent.health();
      this.logger.log(`[CheckApplyAgent] health: available=${healthResult.available} provider=${healthResult.provider} error=${healthResult.error}`);
      if (!healthResult.available) return fail(this.id, started, 'AGENT_UNAVAILABLE', reason);
      if (!this.agent.capabilities.includes('apply-fix')) return fail(this.id, started, 'UNSUPPORTED_CAPABILITY');
      return done(this.id, started, {
        provider: healthResult.provider,
        version: healthResult.version,
        capabilities: healthResult.capabilities,
        strategy: 'agent',
        escalationReason: reason,
      });
    }

    if (proposal?.remediationStrategy === 'local' || proposal?.remediationStrategy === 'llm') {
      if (!proposal.patch) {
        return fail(this.id, started, 'PATCH_UNAVAILABLE');
      }
      return done(this.id, started, {
        provider: proposal.remediationStrategy === 'local' ? 'local-patch-engine' : 'platform-patch-engine',
        strategy: proposal.remediationStrategy,
        editCount: proposal.patch.edits.length,
      });
    }

    // Legacy proposals without an explicit strategy retain the existing agent
    // path until they are regenerated with a platform-applicable patch.
    const health = await this.agent.health();
    if (!health.available) return fail(this.id, started, 'AGENT_UNAVAILABLE');
    if (!this.agent.capabilities.includes('apply-fix')) return fail(this.id, started, 'UNSUPPORTED_CAPABILITY');
    return done(this.id, started, { provider: health.provider, version: health.version, capabilities: health.capabilities });
  }
}

@Injectable()
export class ApplyApprovedFixStep implements PipelineStep {
  readonly id = 'apply-approved-fix'; readonly name = 'Apply Fix';
  private readonly logger = new Logger(ApplyApprovedFixStep.name);
  private readonly contextPolicy = new IssueContextPolicy();
  constructor(
    @Inject(AGENT_PROVIDER) private readonly agent: AgentProvider,
    private readonly safety: GitSafetyService,
    private readonly reports: FixApplicationRepository,
    private readonly patches: StructuredPatchEngine,
  ) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const proposal = context.data.get('fix.proposal') as AgentProposalRecord | undefined;
    const issue = context.data.get('agent.issue') as QualityIssue | undefined;
    const issueContext = context.data.get('agent.issueContext') as QualityIssueContext | undefined;
    const allowedFiles = context.data.get('fix.allowedFiles') as string[] | undefined;
    if (!proposal || !issue || !issueContext?.codeContext || !allowedFiles) return fail(this.id, started, 'APPLY_CONTEXT_INCOMPLETE');

    // Recortar contexto al presupuesto de tokens antes de enviar al agente
    const agentCodeContext = toAgentContext(issueContext.codeContext, issueContext.warnings, issueContext.indexProvider, issueContext.indexState, context.project.path, issue.file);
    const boundedContext = this.contextPolicy.reduce(agentCodeContext);
    const config = loadConfig();
    const maxTokens = config.llm.maxInputTokens;
    const estimatedTokens = boundedContext.estimatedInputTokens;
    const forceAgent = context.data.get('fix.forceAgent') === true;

    this.logger.log(`[ApplyFix] proposalId=${proposal.id} requiresAgent=${proposal.requiresAgent} forceAgent=${forceAgent} strategy=${proposal.remediationStrategy} hasPatch=${Boolean(proposal.patch)} agent=${this.agent.name}`);
    this.logger.log(`[ApplyFix] context: rawTokens=${Math.ceil(JSON.stringify(issueContext.codeContext).length / 4)} boundedTokens=${estimatedTokens} maxTokens=${maxTokens} snippets=${boundedContext.context.snippets?.length}`);
    this.logger.log(`[ApplyFix] escalationReason=${proposal.escalationReason?.slice(0,200) ?? 'none'}`);
    this.logger.log(`[ApplyFix] allowedFiles=${allowedFiles.join(', ')}`);

    // If requiresAgent is true, delegate to the agent provider FIRST
    if (proposal.requiresAgent || forceAgent) {
      const escalationReason = forceAgent
        ? 'El desarrollador solicitó explícitamente aplicar la propuesta con IA.'
        : proposal.escalationReason;
      this.logger.log(`[ApplyFix] Delegating to ${this.agent.name} (forced=${forceAgent})...`);
      const task: AgentTask = {
        id: randomUUID(), type: 'apply-fix', proposalId: proposal.id,
        approvedProposal: proposal, allowedFiles, projectPath: context.project.path,
        project: { id: context.project.id, path: context.project.path, runtime: context.projectProfile.runtime, framework: context.projectProfile.framework },
        issue: { provider: issue.provider, id: issue.id, rule: issue.rule, severity: issue.severity, type: issue.type, message: issue.message, file: issue.file, line: issue.line },
        context: boundedContext.context,
        constraints: ['modify only allowed files', 'preserve existing architecture', 'do not modify secrets or Git configuration', 'do not commit, push, deploy, or install dependencies'],
        validationCommands: { build: context.projectProfile.buildCommand, unit: context.projectProfile.coverageCommand ?? context.projectProfile.testCommand, e2e: context.projectProfile.e2eCommand, startup: context.projectProfile.startCommand },
      };
      this.reports.upsert(reportInput(context, 'applying', { agent: { provider: this.agent.name, escalationReason }, allowedFiles }));
      const applyStarted = Date.now();
      const result = await this.agent.applyFix(task);
      this.logger.log(`[ApplyFix] ${this.agent.name}.applyFix() finished in ${Date.now() - applyStarted}ms: success=${result.success} provider=${result.provider}`);
      this.logger.log(`[ApplyFix] result.summary=${result.summary?.slice(0,300) ?? 'none'}`);
      this.logger.log(`[ApplyFix] result.error=${JSON.stringify(result.error)}`);
      context.data.set('fix.agentResult', result);
      if (!result.success) return fail(this.id, started, result.error?.code ?? 'AGENT_EXECUTION_FAILED', result.error?.message);
      return done(this.id, started, { provider: result.provider, providerVersion: result.providerVersion, proposalId: proposal.id, summary: result.summary, durationMs: result.durationMs, escalationReason });
    }

    // If the proposal is local/llm without a patch, no patch is available
    if (
      (proposal.remediationStrategy === 'local' || proposal.remediationStrategy === 'llm') &&
      !proposal.patch
    ) {
      return fail(this.id, started, 'PATCH_UNAVAILABLE');
    }

    const platformPatch = proposal.patch && (
      proposal.remediationStrategy === 'local' || proposal.remediationStrategy === 'llm'
    );
    if (platformPatch && proposal.patch) {
      const patchProvider = proposal.remediationStrategy === 'local'
        ? 'local-patch-engine'
        : 'platform-patch-engine';
      const patchFiles = proposal.patch.edits.map((edit) => normalizeFile(edit.file));
      if (patchFiles.some((file) => !allowedFiles.includes(file))) {
        return fail(this.id, started, 'PATCH_OUTSIDE_SCOPE');
      }
      this.reports.upsert(reportInput(context, 'applying', {
        localPatch: { provider: patchProvider, files: patchFiles },
        allowedFiles,
      }));
      const applied = this.patches.apply(context.project.path, proposal.patch);
      context.data.set('fix.localPatchResult', applied);
      if (!applied.success) {
        return fail(this.id, started, 'PATCH_APPLY_FAILED', applied.error, {
          provider: patchProvider,
          changedFiles: applied.changedFiles,
        });
      }
      return done(this.id, started, {
        provider: patchProvider,
        proposalId: proposal.id,
        changedFiles: applied.changedFiles,
        editCount: applied.editCount,
        summary: 'Deterministic patch applied by the platform.',
      });
    }

    const task: AgentTask = {
      id: randomUUID(), type: 'apply-fix', proposalId: proposal.id,
      approvedProposal: proposal, allowedFiles, projectPath: context.project.path,
      project: { id: context.project.id, path: context.project.path, runtime: context.projectProfile.runtime, framework: context.projectProfile.framework },
      issue: { provider: issue.provider, id: issue.id, rule: issue.rule, severity: issue.severity, type: issue.type, message: issue.message, file: issue.file, line: issue.line },
      context: boundedContext.context,
      constraints: ['modify only allowed files', 'preserve existing architecture', 'do not modify secrets or Git configuration', 'do not commit, push, deploy, or install dependencies'],
      validationCommands: { build: context.projectProfile.buildCommand, unit: context.projectProfile.coverageCommand ?? context.projectProfile.testCommand, e2e: context.projectProfile.e2eCommand, startup: context.projectProfile.startCommand },
    };
    this.reports.upsert(reportInput(context, 'applying', { agent: { provider: this.agent.name }, allowedFiles }));
    const result = await this.agent.applyFix(task);
    context.data.set('fix.agentResult', result);
    if (!result.success) return fail(this.id, started, result.error?.code ?? 'AGENT_EXECUTION_FAILED', result.error?.message, { detail: result.error?.message, executionTrace: result.executionTrace });
    return done(this.id, started, { provider: result.provider, providerVersion: result.providerVersion, proposalId: proposal.id, summary: result.summary, durationMs: result.durationMs, executionTrace: result.executionTrace });
  }
  async rollback(context: PipelineContext): Promise<void> {
    const baseline = context.data.get('fix.gitBaseline') as GitSafetySnapshot | undefined;
    if (!baseline) throw new Error('ROLLBACK_BASELINE_MISSING');
    const afterApply = context.data.get('fix.gitAfterApply') as GitSafetySnapshot | undefined;
    if (afterApply) {
      const current = await this.safety.capture(context.project.path);
      const sinceApply = this.safety.compare(afterApply, current);
      const unsafeConcurrent = sinceApply.changedFiles.filter(
        (file) => !/^(coverage|dist|\.nyc_output|test-results)(\/|$)/i.test(file),
      );
      if (unsafeConcurrent.length) {
        this.reports.upsert(reportInput(context, 'rollback_failed', { rollback: { verified: false, error: 'Concurrent changes detected', files: unsafeConcurrent } }));
        throw new Error(`ROLLBACK_CONCURRENT_CHANGE_DETECTED: ${unsafeConcurrent.join(', ')}`);
      }
    }
    this.reports.upsert(reportInput(context, 'rolling_back', { reason: 'Pipeline validation failed', validations: context.data.get('fix.validations') ?? {} }));
    const result = await this.safety.rollback(context.project.path, baseline);
    context.data.set('fix.rollback', result);
    const status: FixApplicationStatus = result.verified ? 'rolled_back' : 'rollback_failed';
    this.reports.upsert(reportInput(context, status, { rollback: result, repository: { state: result.verified ? 'restored_to_baseline' : 'rollback_failed' } }));
    if (!result.verified) throw new Error('ROLLBACK_VERIFICATION_FAILED');
  }
}

@Injectable()
export class CaptureRunChangesStep implements PipelineStep {
  readonly id = 'capture-run-changes'; readonly name = 'Capture Changes';
  constructor(private readonly safety: GitSafetyService) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const baseline = context.data.get('fix.gitBaseline') as GitSafetySnapshot | undefined;
    if (!baseline) return fail(this.id, started, 'GIT_BASELINE_MISSING');
    const after = await this.safety.capture(context.project.path);
    const changes = this.safety.compare(baseline, after);
    context.data.set('fix.gitAfterApply', after);
    context.data.set('fix.changes', changes);
    if (!changes.changedFiles.length) return fail(this.id, started, 'NO_FILES_CHANGED');
    return done(this.id, started, { changedFiles: changes.changedFiles, createdFiles: changes.createdFiles, deletedFiles: changes.deletedFiles, linesAdded: changes.linesAdded, linesRemoved: changes.linesRemoved, diff: changes.diff });
  }
}

@Injectable()
export class ValidateChangeScopeStep implements PipelineStep {
  readonly id = 'validate-change-scope'; readonly name = 'Validate Change Scope';
  constructor(private readonly reports: FixApplicationRepository) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const changes = context.data.get('fix.changes') as GitChangeSet | undefined;
    const allowed = new Set((context.data.get('fix.allowedFiles') as string[] | undefined) ?? []);
    if (!changes) return fail(this.id, started, 'CHANGE_SET_MISSING');
    const unexpected = changes.changedFiles.filter((file) => !allowed.has(normalizeFile(file)));
    const sensitive = changes.changedFiles.filter((file) => SENSITIVE_PATH.test(normalizeFile(file)));
    if (unexpected.length || sensitive.length) return fail(this.id, started, 'UNEXPECTED_FILE_CHANGE', JSON.stringify({ unexpected, sensitive }));
    this.reports.upsert(reportInput(context, 'validating', { changes: { changedFiles: changes.changedFiles, createdFiles: changes.createdFiles, deletedFiles: changes.deletedFiles, linesAdded: changes.linesAdded, linesRemoved: changes.linesRemoved, diff: changes.diff } }));
    return done(this.id, started, { valid: true, changedFiles: changes.changedFiles });
  }
}

@Injectable()
export class CompareQualitySnapshotsStep implements PipelineStep {
  readonly id = 'compare-quality-snapshots'; readonly name = 'Compare Before / After';
  constructor(private readonly snapshots: QualitySnapshotRepository) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const before = context.data.get('fix.beforeSnapshot') as QualitySnapshotRecord | undefined;
    const afterId = String(context.data.get('quality.snapshotId') ?? '');
    const after = this.snapshots.findById(afterId);
    const proposal = context.data.get('fix.proposal') as AgentProposalRecord | undefined;
    if (!before || !after || !proposal) return fail(this.id, started, 'QUALITY_COMPARISON_INCOMPLETE');
    const beforeIssues = this.snapshots.listIssues(before.id);
    const afterIssues = this.snapshots.listIssues(after.id);
    const beforeIds = new Set(beforeIssues.map((issue) => issue.id));
    const targetAfter = afterIssues.find((issue) => issue.id === proposal.issueId);
    const resolvedStatuses = new Set(['CLOSED', 'RESOLVED']);
    const targetResolved = beforeIds.has(proposal.issueId) && (
      !targetAfter || resolvedStatuses.has(String(targetAfter.status ?? '').toUpperCase())
    );
    const newIssues = afterIssues.filter((issue) => !beforeIds.has(issue.id));
    const comparison = { before, after, targetIssueId: proposal.issueId, targetResolved, newIssues, totalDelta: after.totalIssues - before.totalIssues };
    context.data.set('fix.qualityComparison', comparison);
    if (!targetResolved) return fail(this.id, started, 'TARGET_ISSUE_REMAINS', undefined, comparison);
    return done(this.id, started, comparison);
  }
}

@Injectable()
export class GenerateFixApplicationReportStep implements PipelineStep {
  readonly id = 'generate-fix-report'; readonly name = 'Generate Report';
  constructor(private readonly reports: FixApplicationRepository) {}
  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const comparison = context.data.get('fix.qualityComparison') as { newIssues?: unknown[] } | undefined;
    const status: FixApplicationStatus = comparison?.newIssues?.length ? 'review_required' : 'completed';
    const record = this.reports.upsert(reportInput(context, status, {
      validations: context.data.get('fix.validations') ?? {},
      quality: comparison,
      repository: { state: 'changes_kept', readyForHumanReview: true },
      durationMs: Date.now() - new Date(String(context.data.get('fix.approvedAt'))).getTime(),
    }));
    context.data.set('fix.report', record);
    return done(this.id, started, record);
  }
}

function reportInput(context: PipelineContext, status: FixApplicationStatus, extra: Record<string, unknown>): Omit<FixApplicationReport, 'id' | 'createdAt' | 'updatedAt'> {
  const proposal = context.data.get('fix.proposal') as AgentProposalRecord | undefined;
  const existing = context.data.get('fix.reportData') as Record<string, unknown> | undefined;
  const data = { ...(existing ?? {}), ...extra };
  context.data.set('fix.reportData', data);
  return {
    runId: context.runId, projectId: context.project.id,
    issueId: proposal?.issueId ?? String(context.data.get('agent.issueId') ?? ''),
    proposalId: proposal?.id ?? String(context.data.get('fix.proposalId') ?? ''),
    approvedBy: String(context.data.get('fix.approvedBy') ?? 'local-developer'),
    approvedAt: String(context.data.get('fix.approvedAt') ?? new Date().toISOString()),
    status, data,
  };
}

function summarizeProposal(proposal: AgentProposalRecord) {
  return { id: proposal.id, summary: proposal.summary, risk: proposal.agentSuggestedRisk, affectedFiles: proposal.affectedFiles, provider: proposal.provider, providerVersion: proposal.providerVersion };
}
function normalizeFile(file: string) { return file.replace(/\\/g, '/').replace(/^\.\//, ''); }
function statusFiles(status: string) { return status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function done(stepId: string, started: Date, result: unknown): PipelineStepResult {
  const finished = new Date(); return { stepId, status: 'success', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result };
}
function fail(stepId: string, started: Date, error: string, detail?: string, result?: unknown): PipelineStepResult {
  const finished = new Date(); return { stepId, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error, result: result ?? (detail ? { detail } : undefined) };
}
