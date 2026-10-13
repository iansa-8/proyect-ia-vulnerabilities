import type { AgentProposal, QualityIssue } from '@amp/core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BulkProposeFixPromptBuilder } from '../agent/bulk-propose-fix-prompt.builder';
import { BulkProposalService } from './bulk-proposal.service';
import { IssueContextPolicy } from './issue-context-policy.service';

function issue(id: string, line: number): QualityIssue {
  return { id, provider: 'sonar', rule: 'typescript:S1854', severity: 'MAJOR', type: 'CODE_SMELL', status: 'OPEN', message: 'Remove assignment', file: 'src/a.ts', line };
}

function proposal(issueId: string): AgentProposal {
  return {
    provider: 'litellm', taskId: `task-${issueId}`, summary: `Fix ${issueId}`,
    proposedChanges: [{ file: 'src/a.ts', description: 'Remove assignment' }],
    affectedFiles: ['src/a.ts'], agentSuggestedRisk: 'low', validationPlan: [],
  };
}

describe('BulkProposalService', () => {
  it('uses the output budget and isolates issues after truncated groups', async () => {
    process.env.AI_PROPOSE_MAX_INPUT_TOKENS = '3000';
    process.env.AI_PROPOSE_MAX_OUTPUT_TOKENS = '1200';
    const issues = [issue('i1', 1), issue('i2', 2), issue('i3', 3), issue('i4', 4)];
    const llm = {
      health: jest.fn(async () => ({ available: true })),
      proposeFixBatch: jest.fn(async (input: { items: Array<{ issue: { id: string } }> }) => {
        const ids = input.items.map((item) => item.issue.id);
        if (ids.length > 1) {
          return { success: false, prompt: 'truncated', durationMs: 1, estimatedInputTokens: 100, inputTokens: 100, outputTokens: 1200, proposals: [], error: { code: 'LLM_OUTPUT_TRUNCATED', message: 'truncated' } };
        }
        return { success: true, prompt: 'ok', durationMs: 1, estimatedInputTokens: 100, inputTokens: 100, outputTokens: 100, model: 'deepseek', proposals: ids.map((id) => ({ issueId: id, proposal: proposal(id) })) };
      }),
    };
    let sequence = 0;
    const service = new BulkProposalService(
      { listSnapshots: () => [{ id: 'snapshot-1' }], getSnapshot: () => ({ issues }) } as never,
      { resolve: async (_projectId: string, current: QualityIssue) => ({ issue: current, warnings: [], indexState: 'ready', indexProvider: 'memory', codeContext: { relatedFiles: [], symbols: [], relations: [], tests: [], snippets: [{ filePath: 'src/a.ts', startLine: 1, endLine: 4, content: 'const value = 1;' }] } }) } as never,
      new IssueContextPolicy(),
      new BulkProposeFixPromptBuilder(),
      llm as never,
      { list: jest.fn(() => []), create: jest.fn(() => ({ id: `proposal-${++sequence}` })) } as never,
      { findById: () => ({ id: 'project-1', path: 'C:/repo', profile: { runtime: 'node', framework: 'nest', packageManager: 'npm', hasDocker: false, hasSonar: true, buildCommand: 'npm run build' } }) } as never,
      { capture: async () => ({ fingerprint: 'same', status: '', trackedDiff: '', stagedDiff: '', fileHashes: { 'src/a.ts': 'hash' } }), unchanged: () => true } as never,
    );

    try {
      const result = await service.propose('project-1', issues.map((item) => item.id));
      expect(llm.proposeFixBatch.mock.calls.map(([input]) => input.items.length).sort()).toEqual([1, 1, 1, 1, 2, 2]);
      expect(result.proposed).toBe(4);
      expect(result.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'grupo-1', status: 'failed', outputTokens: 1200 }),
        expect.objectContaining({ id: 'grupo-1.1', status: 'success', splitFrom: 'grupo-1' }),
        expect.objectContaining({ id: 'grupo-1.2', status: 'success', splitFrom: 'grupo-1' }),
        expect.objectContaining({ id: 'grupo-2', status: 'failed', outputTokens: 1200 }),
        expect.objectContaining({ id: 'grupo-2.1', status: 'success', splitFrom: 'grupo-2' }),
        expect.objectContaining({ id: 'grupo-2.2', status: 'success', splitFrom: 'grupo-2' }),
      ]));
    } finally {
      delete process.env.AI_PROPOSE_MAX_INPUT_TOKENS;
      delete process.env.AI_PROPOSE_MAX_OUTPUT_TOKENS;
    }
  });

  it('reuses a current proposal without resolving context or calling LiteLLM again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-bulk-reuse-'));
    const source = path.join(root, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'const value = 1;');
    const currentIssue = issue('i1', 1);
    const contexts = { resolve: jest.fn() };
    const llm = { health: jest.fn(), proposeFixBatch: jest.fn() };
    const existing = {
      id: 'existing-proposal', issueId: 'i1', status: 'completed',
      contextFiles: ['src/a.ts'],
      contextFileHashes: { 'src/a.ts': createHash('sha256').update(fs.readFileSync(source)).digest('hex') },
    };
    const service = new BulkProposalService(
      { listSnapshots: () => [{ id: 'snapshot-1' }], getSnapshot: () => ({ issues: [currentIssue] }) } as never,
      contexts as never,
      new IssueContextPolicy(),
      new BulkProposeFixPromptBuilder(),
      llm as never,
      { list: () => [existing] } as never,
      { findById: () => ({ id: 'project-1', path: root, profile: { runtime: 'node', framework: 'nest', packageManager: 'npm', hasDocker: false, hasSonar: true, buildCommand: 'npm run build' } }) } as never,
      {} as never,
    );
    try {
      await expect(service.propose('project-1', ['i1'])).resolves.toMatchObject({
        proposed: 0,
        reused: [{ issueId: 'i1', proposalId: 'existing-proposal' }],
        groups: [],
      });
      expect(contexts.resolve).not.toHaveBeenCalled();
      expect(llm.proposeFixBatch).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
