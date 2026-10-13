import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AgentProposal, AgentTask, PipelineContext, PipelineStep, PipelineStepResult, QualityIssue } from '@amp/core';
import type { AgentProvider } from '@amp/providers';
import { AGENT_PROVIDER } from '../../providers/tokens';
import { AgentProposalRepository, type AgentProposalRecord } from '../../persistence/agent-proposal.repository';
import { QualitySnapshotRepository, type QualitySnapshotRecord } from '../../persistence/quality-snapshot.repository';
import { QualityService } from '../../quality/quality.service';
import { GitSafetyService, type GitSafetySnapshot } from '../../agent/git-safety.service';

const SENSITIVE_PATH = /(^|\/)(node_modules(?:\/|$)|\.env(?:\..*)?|credentials?|secrets?|.*\.(?:pem|key|p12|pfx)|service[-_.]?account.*|\.git(?:\/|$)|\.github\/workflows\/.*credentials?)/i;
const MAX_BULK_PROPOSALS = 30;
const MAX_BULK_FILES = 40;

@Injectable()
export class LoadBulkApprovedProposalsStep implements PipelineStep {
  readonly id = 'load-bulk-approved-proposals';
  readonly name = 'Load Bulk Approved Proposals';

  constructor(
    private readonly proposals: AgentProposalRepository,
    private readonly snapshots: QualitySnapshotRepository,
    private readonly quality: QualityService,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const raw = context.data.get('fix.proposalIds');
    const proposalIds = Array.isArray(raw) ? [...new Set(raw.map(String).filter(Boolean))] : [];
    if (!proposalIds.length || proposalIds.length > MAX_BULK_PROPOSALS) {
      return fail(this.id, started, 'INVALID_BULK_PROPOSAL_SELECTION');
    }
    const records: AgentProposalRecord[] = [];
    const issues: QualityIssue[] = [];
    for (const proposalId of proposalIds) {
      const proposal = this.proposals.findById(proposalId);
      if (!proposal || proposal.projectId !== context.project.id) return fail(this.id, started, `PROPOSAL_NOT_FOUND: ${proposalId}`);
      if (proposal.status === 'rejected') return fail(this.id, started, `PROPOSAL_REJECTED: ${proposalId}`);
      const approved = this.proposals.markApproved(proposal.id, String(context.data.get('fix.approvedBy') ?? 'local-developer'));
      if (!approved) return fail(this.id, started, `PROPOSAL_APPROVAL_TRANSITION_FAILED: ${proposalId}`);
      records.push(approved);
      try {
        issues.push(await this.quality.getIssue(context.project.id, approved.issueId));
      } catch {
        return fail(this.id, started, `QUALITY_ISSUE_NOT_FOUND: ${approved.issueId}`);
      }
    }
    const before = this.snapshots.listByProjectId(context.project.id)[0];
    if (!before) return fail(this.id, started, 'QUALITY_BASELINE_REQUIRED');
    context.data.set('fix.proposals', records);
    context.data.set('fix.issues', issues);
    context.data.set('fix.beforeSnapshot', before);
    return done(this.id, started, {
      proposalIds: records.map((item) => item.id),
      issueIds: records.map((item) => item.issueId),
      beforeSnapshotId: before.id,
    });
  }
}

@Injectable()
export class ValidateBulkApprovedProposalsStep implements PipelineStep {
  readonly id = 'validate-bulk-approved-proposals';
  readonly name = 'Validate Bulk Proposals';
  constructor(private readonly safety: GitSafetyService) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const proposals = context.data.get('fix.proposals') as AgentProposalRecord[] | undefined;
    if (!proposals?.length) return fail(this.id, started, 'BULK_PROPOSALS_MISSING');
    if (context.data.get('codeIndex.state') !== 'ready') return fail(this.id, started, 'PROPOSAL_STALE: code index is not ready');
    const current = await this.safety.capture(context.project.path);
    const allowed = [...new Set(proposals.flatMap((proposal) => proposal.affectedFiles.map(normalizeFile)))];
    if (!allowed.length || allowed.length > MAX_BULK_FILES) return fail(this.id, started, 'BULK_FILE_LIMIT_EXCEEDED');
    if (allowed.some((file) => SENSITIVE_PATH.test(file))) return fail(this.id, started, 'SENSITIVE_FILE_CHANGE_FORBIDDEN');
    for (const proposal of proposals) {
      const hashes = Object.entries(proposal.contextFileHashes ?? {});
      if (!proposal.contextRevision || !hashes.length) return fail(this.id, started, `PROPOSAL_STALE: ${proposal.id} has no context hashes`);
      const fileBaselineProposal = (proposal.warnings ?? []).some((warning) => warning.includes('sin repositorio Git'));
      if (current.fingerprint !== proposal.contextRevision && !fileBaselineProposal) {
        return fail(this.id, started, `PROPOSAL_STALE: ${proposal.id} repository revision changed`);
      }
      for (const [file, expected] of hashes) {
        const normalized = normalizeFile(file);
        if (current.fileHashes[normalized] !== expected) return fail(this.id, started, `PROPOSAL_STALE: ${normalized} changed`);
      }
      const patchFiles = [
        ...(proposal.patch?.edits ?? []).map((edit) => normalizeFile(edit.file)),
        ...(proposal.patch?.preconditions ?? []).map((item) => normalizeFile(item.file)),
      ];
      if (patchFiles.some((file) => !proposal.affectedFiles.map(normalizeFile).includes(file))) {
        return fail(this.id, started, `PATCH_FILES_OUTSIDE_SCOPE: ${proposal.id}`);
      }
    }
    context.data.set('fix.allowedFiles', allowed);
    return done(this.id, started, { proposalCount: proposals.length, allowedFiles: allowed });
  }
}

@Injectable()
export class CheckBulkApplyAgentProviderStep implements PipelineStep {
  readonly id = 'check-bulk-apply-agent-provider';
  readonly name = 'Check Bulk Apply Agent';
  constructor(@Inject(AGENT_PROVIDER) private readonly agent: AgentProvider) {}

  async execute(_context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const health = await this.agent.health();
    if (!health.available) return fail(this.id, started, 'AGENT_UNAVAILABLE', health.error);
    if (!this.agent.capabilities.includes('apply-fix')) return fail(this.id, started, 'UNSUPPORTED_CAPABILITY');
    return done(this.id, started, { provider: health.provider, version: health.version });
  }
}

@Injectable()
export class ApplyBulkApprovedFixesStep implements PipelineStep {
  readonly id = 'apply-bulk-approved-fixes';
  readonly name = 'Apply Bulk Fixes';

  constructor(
    @Inject(AGENT_PROVIDER) private readonly agent: AgentProvider,
    private readonly safety: GitSafetyService,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const proposals = context.data.get('fix.proposals') as AgentProposalRecord[] | undefined;
    const issues = context.data.get('fix.issues') as QualityIssue[] | undefined;
    const allowedFiles = context.data.get('fix.allowedFiles') as string[] | undefined;
    if (!proposals?.length || !issues?.length || !allowedFiles?.length) return fail(this.id, started, 'BULK_APPLY_CONTEXT_INCOMPLETE');
    const composite = compositeProposal(proposals, issues, allowedFiles);
    const task: AgentTask = {
      id: randomUUID(),
      type: 'apply-fix',
      proposalId: `bulk:${context.runId}`,
      approvedProposal: composite,
      allowedFiles,
      projectPath: context.project.path,
      project: { id: context.project.id, path: context.project.path, runtime: context.projectProfile.runtime, framework: context.projectProfile.framework },
      issue: {
        provider: 'sonar', id: `bulk:${context.runId}`, severity: 'INFO', type: 'BULK_REMEDIATION',
        message: `Apply ${proposals.length} approved Sonar proposals in one coordinated change.`,
      },
      context: { files: allowedFiles, snippets: [], warnings: [], indexState: 'ready' },
      constraints: [
        'apply every approved proposal in the supplied manifest',
        'modify only allowed files',
        'coordinate overlapping changes in the same file',
        'preserve existing architecture and behavior outside the approved changes',
        'do not modify secrets or Git configuration',
        'do not commit, push, deploy, install dependencies, or run validation commands',
      ],
      validationCommands: {
        build: context.projectProfile.buildCommand,
        unit: context.projectProfile.coverageCommand ?? context.projectProfile.testCommand,
        e2e: context.projectProfile.e2eCommand,
        startup: context.projectProfile.startCommand,
      },
    };
    const result = await this.agent.applyFix(task);
    context.data.set('fix.agentResult', result);
    if (!result.success) return fail(this.id, started, result.error?.code ?? 'AGENT_EXECUTION_FAILED', result.error?.message);
    return done(this.id, started, {
      provider: result.provider,
      providerVersion: result.providerVersion,
      proposalIds: proposals.map((item) => item.id),
      summary: result.summary,
      durationMs: result.durationMs,
    });
  }

  async rollback(context: PipelineContext): Promise<void> {
    const baseline = context.data.get('fix.gitBaseline') as GitSafetySnapshot | undefined;
    if (!baseline) throw new Error('ROLLBACK_BASELINE_MISSING');
    const result = await this.safety.rollback(context.project.path, baseline);
    context.data.set('fix.rollback', result);
    if (!result.verified) throw new Error('ROLLBACK_VERIFICATION_FAILED');
  }
}

@Injectable()
export class CompareBulkQualitySnapshotsStep implements PipelineStep {
  readonly id = 'compare-bulk-quality-snapshots';
  readonly name = 'Compare Bulk Before / After';
  constructor(private readonly snapshots: QualitySnapshotRepository) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const before = context.data.get('fix.beforeSnapshot') as QualitySnapshotRecord | undefined;
    const after = this.snapshots.findById(String(context.data.get('quality.snapshotId') ?? ''));
    const proposals = context.data.get('fix.proposals') as AgentProposalRecord[] | undefined;
    if (!before || !after || !proposals?.length) return fail(this.id, started, 'QUALITY_COMPARISON_INCOMPLETE');
    const beforeIssues = this.snapshots.listIssues(before.id);
    const afterIssues = this.snapshots.listIssues(after.id);
    const beforeIds = new Set(beforeIssues.map((issue) => issue.id));
    const afterById = new Map(afterIssues.map((issue) => [issue.id, issue]));
    const resolvedStatuses = new Set(['CLOSED', 'RESOLVED']);
    const targetIssueIds = proposals.map((proposal) => proposal.issueId);
    const resolvedIssueIds = targetIssueIds.filter((id) => {
      const issue = afterById.get(id);
      return beforeIds.has(id) && (!issue || resolvedStatuses.has(String(issue.status ?? '').toUpperCase()));
    });
    const remainingIssueIds = targetIssueIds.filter((id) => !resolvedIssueIds.includes(id));
    const newIssues = afterIssues.filter((issue) => !beforeIds.has(issue.id));
    const comparison = {
      beforeSnapshotId: before.id,
      afterSnapshotId: after.id,
      targetIssueIds,
      resolvedIssueIds,
      remainingIssueIds,
      newIssues,
      totalDelta: after.totalIssues - before.totalIssues,
      outcome: remainingIssueIds.length || newIssues.length ? 'review_required' : 'completed',
    };
    context.data.set('fix.qualityComparison', comparison);
    return done(this.id, started, comparison);
  }
}

function compositeProposal(proposals: AgentProposalRecord[], issues: QualityIssue[], allowedFiles: string[]): AgentProposal {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  return {
    provider: 'platform-bulk-manifest',
    taskId: randomUUID(),
    summary: `Apply ${proposals.length} approved Sonar remediation proposals in one coordinated execution.`,
    diagnosis: proposals.map((proposal) => {
      const issue = issueById.get(proposal.issueId);
      return `${proposal.issueId} ${issue?.rule ?? ''}: ${proposal.summary}`.trim();
    }).join('\n'),
    proposedChanges: proposals.flatMap((proposal) => proposal.proposedChanges.map((change) => ({
      ...change,
      description: `[${proposal.issueId}] ${change.description}`,
    }))),
    affectedFiles: allowedFiles,
    agentSuggestedRisk: proposals.some((item) => item.agentSuggestedRisk === 'high') ? 'high'
      : proposals.some((item) => item.agentSuggestedRisk === 'medium') ? 'medium' : 'low',
    validationPlan: [...new Set(proposals.flatMap((proposal) => proposal.validationPlan))],
    assumptions: proposals.map((proposal) => `${proposal.issueId}: ${proposal.summary}`),
    warnings: [...new Set(proposals.flatMap((proposal) => proposal.warnings ?? []))],
    remediationStrategy: 'agent',
    requiresAgent: true,
    escalationReason: 'The developer approved applying the selected proposals in one coordinated agent execution.',
  };
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function done(stepId: string, started: Date, result: unknown): PipelineStepResult {
  const finished = new Date();
  return { stepId, status: 'success', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), result };
}

function fail(stepId: string, started: Date, error: string, detail?: string): PipelineStepResult {
  const finished = new Date();
  return { stepId, status: 'failed', startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), error, result: detail ? { detail } : undefined };
}
