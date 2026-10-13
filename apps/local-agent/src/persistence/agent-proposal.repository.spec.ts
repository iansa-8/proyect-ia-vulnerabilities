import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteService } from './sqlite.service';
import { AgentProposalRepository } from './agent-proposal.repository';

describe('AgentProposalRepository', () => {
  let dir: string;
  let sqlite: SqliteService;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-proposal-'));
    process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
    sqlite = new SqliteService();
    await sqlite.onModuleInit();
  });
  afterEach(() => {
    sqlite.onModuleDestroy();
    delete process.env.SQLITE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists structured metadata and keeps independent proposal history', () => {
    const repo = new AgentProposalRepository(sqlite);
    const input = {
      projectId: 'project-1',
      issueId: 'issue-1',
      provider: 'codex',
      providerVersion: '1.0.0',
      taskId: 'task-1',
      summary: 'Summary',
      proposedChanges: [{ file: 'src/a.ts', description: 'Change it' }],
      affectedFiles: ['src/a.ts'],
      agentSuggestedRisk: 'low' as const,
      validationPlan: ['npm test'],
      contextFiles: ['src/a.ts'],
      contextSizeChars: 10,
      repositoryUnchanged: true,
      contextFileHashes: { 'src/a.ts': 'hash-a' },
      patch: {
        version: 1 as const,
        edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'before', replacement: 'after' }],
        preconditions: [],
      },
      contextRevision: 'revision-a',
      executionTrace: {
        indexProvider: 'codebase-memory',
        indexState: 'fresh',
        targetSymbol: 'A.run',
        filesIncluded: ['src/a.ts'],
        symbolsIncluded: 1,
        snippetsIncluded: 1,
        snippetChars: 10,
        promptChars: 100,
        promptSha256: 'a'.repeat(64),
        promptPreview: 'sanitized prompt',
        promptPreviewTruncated: false,
      },
    };
    const first = repo.create(input);
    const second = repo.create({ ...input, taskId: 'task-2' });
    expect(first.id).not.toBe(second.id);
    expect(repo.list('project-1', 'issue-1')).toHaveLength(2);
    expect(repo.list('project-1', 'issue-1')[0]).toMatchObject({
      repositoryUnchanged: true,
      rawResponseAvailable: false,
      agentSuggestedRisk: 'low',
      patch: { version: 1, edits: [{ file: 'src/a.ts' }] },
      executionTrace: {
        indexProvider: 'codebase-memory',
        promptSha256: 'a'.repeat(64),
        promptPreview: 'sanitized prompt',
      },
    });
  });

  it('does not allow a rejected proposal to transition back to approved', () => {
    const repo = new AgentProposalRepository(sqlite);
    const proposal = repo.create({
      projectId: 'project-1',
      issueId: 'issue-1',
      provider: 'local',
      taskId: 'task-rejected',
      summary: 'Rejected proposal',
      proposedChanges: [{ file: 'src/a.ts', description: 'Change it' }],
      affectedFiles: ['src/a.ts'],
      agentSuggestedRisk: 'low' as const,
      validationPlan: ['npm test'],
      contextFiles: ['src/a.ts'],
      contextSizeChars: 10,
      repositoryUnchanged: true,
      contextFileHashes: { 'src/a.ts': 'hash-a' },
    });

    repo.markRejected(proposal.id);

    expect(repo.markApproved(proposal.id, 'developer')).toBeNull();
    expect(repo.findById(proposal.id)?.status).toBe('rejected');
  });
});
