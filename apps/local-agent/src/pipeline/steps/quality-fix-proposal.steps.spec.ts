import type { AgentProposal, PipelineContext, QualityIssue } from '@amp/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider } from '@amp/providers';
import type { AgentProposalRepository } from '../../persistence/agent-proposal.repository';
import type { WorkingTreeGuardService, WorkingTreeSnapshot } from '../../agent/working-tree-guard.service';
import { ProposeFixStep } from './propose-fix.step';
import { VerifyRepositoryUnchangedStep } from './verify-repository-unchanged.step';
import { PersistAgentProposalStep } from './persist-agent-proposal.step';
import { CaptureWorkingTreeBaselineStep } from './capture-working-tree-baseline.step';
import { RemediationRouter } from '../../remediation/remediation-router.service';
import { IssueContextPolicy } from '../../remediation/issue-context-policy.service';
import { DeterministicRemediator } from '../../remediation/deterministic-remediator.service';

const baseIssue: QualityIssue = { id: 'issue-1', provider: 'sonar', rule: 'typescript:S3776', severity: 'CRITICAL', message: 'Reduce complexity', file: 'src/a.ts', line: 10 };
const proposal: AgentProposal = {
  provider: 'litellm', taskId: 'task-1', summary: 'Extract helpers',
  proposedChanges: [{ file: 'src/a.ts', description: 'Extract validation helpers' }],
  affectedFiles: ['src/a.ts'], agentSuggestedRisk: 'medium', validationPlan: ['npm run build'],
};

function context(issue: QualityIssue = baseIssue): PipelineContext {
  const ctx = {
    runId: 'run-1', project: { id: 'project-1', name: 'p', path: 'C:\\repo', createdAt: '', updatedAt: '' },
    projectProfile: { runtime: 'node', framework: 'nest', buildCommand: 'npm run build', hasDocker: false, hasSonar: true }, data: new Map(),
  } as PipelineContext;
  ctx.data.set('agent.issue', issue);
  ctx.data.set('agent.issueContext', {
    issue, warnings: [], indexProvider: 'codebase-memory', indexState: 'fresh',
    codeContext: {
      query: { projectId: 'project-1', projectPath: 'C:\\repo' },
      target: { name: 'run', qualifiedName: 'A.run', filePath: 'C:\\repo\\src\\a.ts' },
      symbols: [{ name: 'run', filePath: 'src/a.ts' }], relatedFiles: ['src/a.ts'], relations: [], tests: [],
      snippets: [{ filePath: 'src/a.ts', content: 'run() {}' }],
    },
  });
  return ctx;
}

function llm(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: 'litellm',
    health: jest.fn(async () => ({ available: true, provider: 'litellm', model: 'small' })),
    proposeFix: jest.fn(async (task) => ({
      success: true, summary: proposal.summary, touchedFiles: [], provider: 'litellm', model: 'small',
      proposal: { ...proposal, taskId: task.id! }, usage: { estimatedInputTokens: 250, inputTokens: 240, outputTokens: 60 },
    })),
    ...overrides,
  };
}

function step(provider: LLMProvider) {
  return new ProposeFixStep(provider, new RemediationRouter(), new IssueContextPolicy(), new DeterministicRemediator());
}

describe('Quality Fix Proposal steps', () => {
  it('routes S3776 to LiteLLM with bounded context', async () => {
    const provider = llm();
    const ctx = context();
    const result = await step(provider).execute(ctx);
    expect(result).toMatchObject({ status: 'success', result: { remediationStrategy: 'llm', provider: 'litellm' } });
    expect(provider.proposeFix).toHaveBeenCalledWith(expect.objectContaining({ type: 'propose-fix', context: expect.objectContaining({ targetSymbol: 'A.run', files: ['src/a.ts'] }) }));
  });

  it('uses LOCAL for a deterministic rule and makes zero LLM calls', async () => {
    const provider = llm();
    const ctx = context({ ...baseIssue, rule: 'typescript:S1186', message: 'Unexpected empty constructor.' });
    const result = await step(provider).execute(ctx);
    expect(result).toMatchObject({ status: 'success', result: { remediationStrategy: 'local', provider: 'local', estimatedInputTokens: 0 } });
    expect(provider.health).not.toHaveBeenCalled();
    expect(provider.proposeFix).not.toHaveBeenCalled();
  });

  it('allows the developer to force AI for a deterministic local rule', async () => {
    const provider = llm();
    const ctx = context({ ...baseIssue, rule: 'typescript:S1186', message: 'Unexpected empty constructor.' });
    ctx.data.set('remediation.forceAI', true);

    const result = await step(provider).execute(ctx);

    expect(result).toMatchObject({
      status: 'success',
      result: { remediationStrategy: 'llm', provider: 'litellm' },
    });
    expect(provider.proposeFix).toHaveBeenCalledTimes(1);
  });

  it('returns manual review when code context is insufficient', async () => {
    const ctx = context();
    (ctx.data.get('agent.issueContext') as { codeContext: { snippets: unknown[] } }).codeContext.snippets = [];
    await expect(step(llm()).execute(ctx)).resolves.toMatchObject({ status: 'failed', error: 'MANUAL_REVIEW_REQUIRED' });
  });

  it('returns a controlled error when LiteLLM is unavailable', async () => {
    const provider = llm({ health: async () => ({ available: false, provider: 'litellm', error: 'offline' }) });
    await expect(step(provider).execute(context())).resolves.toMatchObject({ status: 'failed', error: 'LLM_UNAVAILABLE' });
  });

  it('creates an exact S2933 patch through the local route without LLM calls', async () => {
    const provider = llm();
    const ctx = context({ ...baseIssue, rule: 'typescript:S2933', line: 10 });
    (ctx.data.get('agent.issueContext') as { codeContext: { snippets: unknown[] } }).codeContext.snippets = [{
      filePath: 'src/a.ts', startLine: 10, endLine: 10, content: 'private hola: string;',
    }];

    const result = await step(provider).execute(ctx);

    expect(result).toMatchObject({ status: 'success', result: { remediationStrategy: 'local', provider: 'local' } });
    expect((ctx.data.get('agent.result') as { proposal?: { patch?: unknown } }).proposal?.patch).toMatchObject({
      version: 1,
      edits: [{ file: 'src/a.ts', startLine: 10, replacement: 'private readonly hola: string;' }],
    });
    expect(provider.health).not.toHaveBeenCalled();
    expect(provider.proposeFix).not.toHaveBeenCalled();
  });

  it('verifies repository immutability before persistence', async () => {
    const before: WorkingTreeSnapshot = {
      fingerprint: 'same', status: '', trackedDiff: '', stagedDiff: '',
      fileHashes: { 'src/a.ts': 'hash' },
    };
    const guard = { capture: jest.fn().mockResolvedValue(before), unchanged: jest.fn().mockReturnValue(true) } as unknown as WorkingTreeGuardService;
    const ctx = context();
    ctx.data.set('agent.workingTreeBefore', before);
    await step(llm()).execute(ctx);
    await new VerifyRepositoryUnchangedStep(guard).execute(ctx);
    const create = jest.fn((value) => ({ ...value, id: 'proposal-1', createdAt: '', status: 'completed' }));
    const persisted = await new PersistAgentProposalStep({ create } as unknown as AgentProposalRepository).execute(ctx);
    expect(persisted.status).toBe('success');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ remediationStrategy: 'llm', repositoryUnchanged: true }));
  });

  it('uses context-file hashes for read-only proposals outside a Git repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-proposal-baseline-'));
    const source = path.join(root, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'run() {}');
    const ctx = context();
    ctx.project.path = root;
    const issueContext = ctx.data.get('agent.issueContext') as { codeContext: { relatedFiles: string[]; snippets: Array<{ filePath: string; content: string }> } };
    issueContext.codeContext.relatedFiles = ['src/a.ts'];
    issueContext.codeContext.snippets = [{ filePath: 'src/a.ts', content: 'run() {}' }];
    const guard = {
      capture: jest.fn().mockRejectedValue(new Error('GIT_REPOSITORY_REQUIRED')),
      unchanged: jest.fn(),
    } as unknown as WorkingTreeGuardService;
    try {
      await expect(new CaptureWorkingTreeBaselineStep(guard).execute(ctx)).resolves.toMatchObject({
        status: 'success', result: { mode: 'context-files' },
      });
      fs.writeFileSync(source, 'run() { return true; }');
      await expect(new VerifyRepositoryUnchangedStep(guard).execute(ctx)).resolves.toMatchObject({
        status: 'failed', error: 'AGENT_WRITE_DETECTED', result: { mode: 'context-files' },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
