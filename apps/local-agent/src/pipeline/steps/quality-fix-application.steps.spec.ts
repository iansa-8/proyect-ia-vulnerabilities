import type { AgentProvider } from '@amp/providers';
import type { PipelineContext, QualityIssue } from '@amp/core';
import type { AgentProposalRecord, AgentProposalRepository } from '../../persistence/agent-proposal.repository';
import type { FixApplicationRepository } from '../../persistence/fix-application.repository';
import type { GitSafetyService, GitSafetySnapshot } from '../../agent/git-safety.service';
import type { QualitySnapshotRepository } from '../../persistence/quality-snapshot.repository';
import { StructuredPatchEngine } from '../../remediation/structured-patch.engine';
import { ApplyApprovedFixStep, CheckApplyAgentProviderStep, CompareQualitySnapshotsStep, LoadApprovedProposalStep, ValidateApprovedProposalStep, ValidateChangeScopeStep } from './quality-fix-application.steps';
import { ApplyBulkApprovedFixesStep, CompareBulkQualitySnapshotsStep, ValidateBulkApprovedProposalsStep } from './bulk-fix-application.steps';

const issue: QualityIssue = { id: 'issue-1', provider: 'sonar', rule: 'typescript:S1', severity: 'MAJOR', message: 'fix', file: 'src/a.ts', line: 1 };
const proposal = {
  id: 'proposal-1', projectId: 'project-1', issueId: issue.id, provider: 'codex',
  taskId: 'task-1', createdAt: '', status: 'approved', summary: 'fix it',
  proposedChanges: [{ file: 'src/a.ts', description: 'change' }], affectedFiles: ['src/a.ts'],
  agentSuggestedRisk: 'medium', validationPlan: ['npm test'], contextFiles: ['src/a.ts'],
  contextSizeChars: 10, repositoryUnchanged: true, contextRevision: 'before',
  contextFileHashes: { 'src/a.ts': 'before-hash' },
} as AgentProposalRecord;
const baseline: GitSafetySnapshot = { fingerprint: 'before', status: ' M developer.ts', trackedDiff: '', stagedDiff: '', fileHashes: { 'src/a.ts': 'before-hash' }, fileContents: { 'src/a.ts': Buffer.from('before').toString('base64') } };

function context(): PipelineContext {
  const value = {
    runId: 'run-1', project: { id: 'project-1', name: 'p', path: 'C:\\repo', createdAt: '', updatedAt: '' },
    projectProfile: { runtime: 'node', framework: 'nest', buildCommand: 'npm run build', hasDocker: false, hasSonar: true }, data: new Map(),
  } as PipelineContext;
  value.data.set('fix.proposal', proposal);
  value.data.set('fix.proposalId', proposal.id);
  value.data.set('fix.approvedBy', 'developer');
  value.data.set('fix.approvedAt', new Date().toISOString());
  value.data.set('codeIndex.state', 'ready');
  value.data.set('agent.issue', issue);
  value.data.set('agent.issueContext', {
    issue, warnings: [], indexProvider: 'codebase-memory', indexState: 'ready',
    codeContext: { query: {}, symbols: [], relatedFiles: ['src/a.ts'], relations: [], tests: [], snippets: [{ filePath: 'src/a.ts', content: 'before' }] },
  });
  value.data.set('fix.allowedFiles', ['src/a.ts']);
  value.data.set('fix.gitBaseline', baseline);
  return value;
}

const reports = {
  upsert: jest.fn((input) => ({ ...input, id: 'report-1', createdAt: '', updatedAt: '' })),
} as unknown as FixApplicationRepository;

describe('Quality Fix Application steps', () => {
  it('blocks a rejected proposal before changing its approval state', async () => {
    const proposals = {
      findById: jest.fn().mockReturnValue({ ...proposal, status: 'rejected' } as AgentProposalRecord),
      markApproved: jest.fn(),
    } as unknown as AgentProposalRepository;
    const step = new LoadApprovedProposalStep(
      proposals,
      {} as unknown as QualitySnapshotRepository,
      {} as unknown as FixApplicationRepository,
    );

    await expect(step.execute(context())).resolves.toMatchObject({
      status: 'failed',
      error: 'PROPOSAL_REJECTED',
    });
    expect(proposals.markApproved).not.toHaveBeenCalled();
  });

  it('detects stale proposal context and accepts an exact revision', async () => {
    const capture = jest.fn().mockResolvedValueOnce({ ...baseline, fileHashes: { 'src/a.ts': 'changed' } }).mockResolvedValueOnce(baseline);
    const safety = { capture } as unknown as GitSafetyService;
    await expect(new ValidateApprovedProposalStep(safety).execute(context())).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('PROPOSAL_STALE') });
    await expect(new ValidateApprovedProposalStep(safety).execute(context())).resolves.toMatchObject({ status: 'success' });
  });

  it('rejects a proposal when the repository changed outside the context files', async () => {
    const safety = {
      capture: jest.fn().mockResolvedValue({ ...baseline, fingerprint: 'different' }),
    } as unknown as GitSafetyService;

    await expect(new ValidateApprovedProposalStep(safety).execute(context())).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('repository working tree changed'),
    });
  });

  it('rejects files outside approved scope and sensitive files', async () => {
    const ctx = context();
    ctx.data.set('fix.changes', { changedFiles: ['src/a.ts', 'src/unexpected.ts'], createdFiles: [], deletedFiles: [], changes: [], diff: '', linesAdded: 1, linesRemoved: 1 });
    await expect(new ValidateChangeScopeStep(reports).execute(ctx)).resolves.toMatchObject({ status: 'failed', error: 'UNEXPECTED_FILE_CHANGE' });
    ctx.data.set('fix.allowedFiles', ['.env']);
    ctx.data.set('fix.changes', { changedFiles: ['.env'], createdFiles: [], deletedFiles: [], changes: [], diff: '', linesAdded: 1, linesRemoved: 1 });
    await expect(new ValidateChangeScopeStep(reports).execute(ctx)).resolves.toMatchObject({ status: 'failed', error: 'UNEXPECTED_FILE_CHANGE' });
    ctx.data.set('fix.allowedFiles', ['node_modules/dependency/index.js']);
    ctx.data.set('fix.changes', { changedFiles: ['node_modules/dependency/index.js'], createdFiles: [], deletedFiles: [], changes: [], diff: '', linesAdded: 1, linesRemoved: 1 });
    await expect(new ValidateChangeScopeStep(reports).execute(ctx)).resolves.toMatchObject({ status: 'failed', error: 'UNEXPECTED_FILE_CHANGE' });
  });

  it('applies the approved proposal through AgentProvider and rolls back to the captured baseline', async () => {
    const agent = {
      name: 'codex', capabilities: ['propose-fix', 'apply-fix'],
      health: async () => ({ available: true, provider: 'codex', capabilities: ['propose-fix', 'apply-fix'] }),
      execute: async () => ({ success: true, summary: '', touchedFiles: [] }),
      proposeFix: async () => ({ success: false, summary: '', touchedFiles: [] }),
      applyFix: jest.fn(async () => ({ success: true, summary: 'applied', touchedFiles: [], provider: 'codex', providerVersion: '1', durationMs: 5 })),
    } as AgentProvider;
    const safety = {
      capture: jest.fn().mockResolvedValue(baseline),
      compare: jest.fn().mockReturnValue({ changedFiles: [], changes: [], createdFiles: [], deletedFiles: [], diff: '', linesAdded: 0, linesRemoved: 0 }),
      rollback: jest.fn().mockResolvedValue({ restoredFiles: ['src/a.ts'], verified: true }),
    } as unknown as GitSafetyService;
    const step = new ApplyApprovedFixStep(agent, safety, reports, {} as StructuredPatchEngine);
    const ctx = context();
    await expect(step.execute(ctx)).resolves.toMatchObject({ status: 'success' });
    expect(agent.applyFix).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'proposal-1', allowedFiles: ['src/a.ts'] }));
    await step.rollback(ctx);
    expect(safety.rollback).toHaveBeenCalledWith('C:\\repo', baseline);
  });

  it('does not require the coding agent for a local structured patch', async () => {
    const agent = {
      health: jest.fn(),
    } as unknown as AgentProvider;
    const ctx = context();
    ctx.data.set('fix.proposal', {
      ...proposal,
      remediationStrategy: 'local',
      patch: { version: 1, edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'before', replacement: 'after' }], preconditions: [] },
    } as AgentProposalRecord);

    await expect(new CheckApplyAgentProviderStep(agent).execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: { provider: 'local-patch-engine' },
    });
    expect(agent.health).not.toHaveBeenCalled();
  });

  it('applies a local structured patch without invoking the coding agent', async () => {
    const agent = {
      applyFix: jest.fn(),
      health: jest.fn(),
    } as unknown as AgentProvider;
    const patches = {
      apply: jest.fn().mockReturnValue({ success: true, changedFiles: ['src/a.ts'], editCount: 1 }),
    } as unknown as StructuredPatchEngine;
    const localProposal = {
      ...proposal,
      remediationStrategy: 'local' as const,
      patch: {
        version: 1 as const,
        edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'before', replacement: 'after' }],
        preconditions: [],
      },
    } as AgentProposalRecord;
    const ctx = context();
    ctx.data.set('fix.proposal', localProposal);
    const step = new ApplyApprovedFixStep(agent, {} as GitSafetyService, reports, patches);

    await expect(step.execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: { provider: 'local-patch-engine', changedFiles: ['src/a.ts'] },
    });
    expect(patches.apply).toHaveBeenCalledWith('C:\\repo', localProposal.patch);
    expect(agent.applyFix).not.toHaveBeenCalled();
  });

  it('allows the developer to force agent application for a local proposal', async () => {
    const agent = {
      name: 'opencode', capabilities: ['apply-fix'],
      health: jest.fn(async () => ({ available: true, provider: 'opencode', capabilities: ['apply-fix'] })),
      applyFix: jest.fn(async () => ({ success: true, summary: 'applied by AI', touchedFiles: ['src/a.ts'], provider: 'opencode', durationMs: 5 })),
    } as unknown as AgentProvider;
    const patches = { apply: jest.fn() } as unknown as StructuredPatchEngine;
    const ctx = context();
    ctx.data.set('fix.proposal', {
      ...proposal,
      remediationStrategy: 'local',
      patch: { version: 1, edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'before', replacement: 'after' }], preconditions: [] },
    } as AgentProposalRecord);
    ctx.data.set('fix.forceAgent', true);

    await expect(new CheckApplyAgentProviderStep(agent).execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: { provider: 'opencode', strategy: 'agent' },
    });
    await expect(new ApplyApprovedFixStep(agent, {} as GitSafetyService, reports, patches).execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: { provider: 'opencode' },
    });
    expect(agent.applyFix).toHaveBeenCalledTimes(1);
    expect(patches.apply).not.toHaveBeenCalled();
  });

  it('compares target resolution and detects new issues', async () => {
    const before = { id: 'before', projectId: 'project-1', provider: 'sonar', createdAt: '', totalIssues: 2, severityCounts: {}, typeCounts: {} };
    const after = { ...before, id: 'after', totalIssues: 2 };
    const snapshots = {
      findById: jest.fn().mockReturnValue(after),
      listIssues: jest.fn().mockReturnValueOnce([issue, { ...issue, id: 'old' }]).mockReturnValueOnce([{ ...issue, id: 'old' }, { ...issue, id: 'new' }]),
    } as unknown as QualitySnapshotRepository;
    const ctx = context();
    ctx.data.set('fix.beforeSnapshot', before);
    ctx.data.set('quality.snapshotId', 'after');
    const result = await new CompareQualitySnapshotsStep(snapshots).execute(ctx);
    expect(result).toMatchObject({ status: 'success', result: { targetResolved: true, newIssues: [expect.objectContaining({ id: 'new' })] } });
  });

  it('treats a target retained by Sonar with CLOSED status as resolved', async () => {
    const before = { id: 'before', projectId: 'project-1', provider: 'sonar', createdAt: '', totalIssues: 1, severityCounts: {}, typeCounts: {} };
    const after = { ...before, id: 'after', totalIssues: 2 };
    const snapshots = {
      findById: jest.fn().mockReturnValue(after),
      listIssues: jest.fn()
        .mockReturnValueOnce([issue])
        .mockReturnValueOnce([
          { ...issue, status: 'CLOSED' },
          { ...issue, id: 'new', status: 'OPEN' },
        ]),
    } as unknown as QualitySnapshotRepository;
    const ctx = context();
    ctx.data.set('fix.beforeSnapshot', before);
    ctx.data.set('quality.snapshotId', 'after');

    const result = await new CompareQualitySnapshotsStep(snapshots).execute(ctx);

    expect(result).toMatchObject({
      status: 'success',
      result: {
        targetResolved: true,
        newIssues: [expect.objectContaining({ id: 'new' })],
      },
    });
  });

  it('validates fallback proposals by exact context hashes after Git is initialized', async () => {
    const ctx = context();
    ctx.data.set('fix.proposals', [{
      ...proposal,
      warnings: ['Proyecto sin repositorio Git: la propuesta se protegió con hashes de contexto.'],
    }]);
    const safety = {
      capture: jest.fn().mockResolvedValue({ ...baseline, fingerprint: 'new-git-fingerprint' }),
    } as unknown as GitSafetyService;

    await expect(new ValidateBulkApprovedProposalsStep(safety).execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: { proposalCount: 1, allowedFiles: ['src/a.ts'] },
    });
  });

  it('applies several approved proposals with one agent invocation', async () => {
    const secondIssue = { ...issue, id: 'issue-2', file: 'src/b.ts' };
    const secondProposal = {
      ...proposal,
      id: 'proposal-2',
      issueId: secondIssue.id,
      affectedFiles: ['src/b.ts'],
      proposedChanges: [{ file: 'src/b.ts', description: 'change b' }],
    } as AgentProposalRecord;
    const agent = {
      name: 'opencode', capabilities: ['apply-fix'],
      applyFix: jest.fn(async () => ({ success: true, summary: 'batch applied', touchedFiles: [], provider: 'opencode', durationMs: 8 })),
    } as unknown as AgentProvider;
    const safety = {
      rollback: jest.fn().mockResolvedValue({ restoredFiles: ['src/a.ts', 'src/b.ts'], verified: true }),
    } as unknown as GitSafetyService;
    const ctx = context();
    ctx.data.set('fix.proposals', [proposal, secondProposal]);
    ctx.data.set('fix.issues', [issue, secondIssue]);
    ctx.data.set('fix.allowedFiles', ['src/a.ts', 'src/b.ts']);
    const step = new ApplyBulkApprovedFixesStep(agent, safety);

    await expect(step.execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: { proposalIds: ['proposal-1', 'proposal-2'] },
    });
    expect(agent.applyFix).toHaveBeenCalledTimes(1);
    expect(agent.applyFix).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: 'bulk:run-1',
      allowedFiles: ['src/a.ts', 'src/b.ts'],
      approvedProposal: expect.objectContaining({ affectedFiles: ['src/a.ts', 'src/b.ts'] }),
    }));
  });

  it('reports partial bulk resolution without failing the validated run', async () => {
    const secondIssue = { ...issue, id: 'issue-2' };
    const before = { id: 'before', projectId: 'project-1', provider: 'sonar', createdAt: '', totalIssues: 2, severityCounts: {}, typeCounts: {} };
    const after = { ...before, id: 'after', totalIssues: 1 };
    const snapshots = {
      findById: jest.fn().mockReturnValue(after),
      listIssues: jest.fn().mockReturnValueOnce([issue, secondIssue]).mockReturnValueOnce([secondIssue]),
    } as unknown as QualitySnapshotRepository;
    const ctx = context();
    ctx.data.set('fix.beforeSnapshot', before);
    ctx.data.set('fix.proposals', [proposal, { ...proposal, id: 'proposal-2', issueId: 'issue-2' }]);
    ctx.data.set('quality.snapshotId', 'after');

    await expect(new CompareBulkQualitySnapshotsStep(snapshots).execute(ctx)).resolves.toMatchObject({
      status: 'success',
      result: {
        resolvedIssueIds: ['issue-1'],
        remainingIssueIds: ['issue-2'],
        outcome: 'review_required',
      },
    });
  });
});
