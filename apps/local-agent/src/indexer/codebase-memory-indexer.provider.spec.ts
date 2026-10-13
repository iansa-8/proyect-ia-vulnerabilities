import type { CommandRequest, CommandResult } from '@amp/core';
import { CodebaseMemoryIndexerProvider } from './codebase-memory-indexer.provider';
import type { CommandExecutionService } from '../execution/command-execution.service';
import type { ProjectIndexRepository } from '../persistence/project-index.repository';
import type { ProjectRepository } from '../persistence/project.repository';
import type { ProjectIndexRecord } from '../persistence/project-index.repository';

function okResult(
  stdout: string,
  partial?: Partial<CommandResult>,
): CommandResult {
  const now = new Date();
  return {
    command: 'codebase-memory-mcp',
    args: [],
    cwd: 'C:\\tmp\\demo',
    exitCode: 0,
    stdout,
    stderr: '',
    startedAt: now,
    finishedAt: now,
    durationMs: 5,
    timedOut: false,
    success: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...partial,
  };
}

function failResult(
  stderr: string,
  partial?: Partial<CommandResult>,
): CommandResult {
  const now = new Date();
  return {
    command: 'codebase-memory-mcp',
    args: [],
    cwd: 'C:\\tmp\\demo',
    exitCode: 1,
    stdout: '',
    stderr,
    startedAt: now,
    finishedAt: now,
    durationMs: 5,
    timedOut: false,
    success: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...partial,
  };
}

describe('CodebaseMemoryIndexerProvider', () => {
  const projectPath = process.cwd();
  let store: Map<string, ProjectIndexRecord>;
  let executeMock: jest.MockedFunction<
    (req: CommandRequest) => Promise<CommandResult>
  >;
  let provider: CodebaseMemoryIndexerProvider;

  beforeEach(() => {
    store = new Map();
    executeMock = jest.fn();
    process.env.CODEBASE_MEMORY_COMMAND = 'codebase-memory-mcp';
    process.env.INDEXER_PROVIDER = 'codebase-memory';
    process.env.CODEBASE_MEMORY_UI_URL = 'http://127.0.0.1:9';

    const commands = {
      execute: executeMock,
    } as unknown as CommandExecutionService;

    const indexes = {
      findByProjectId: (id: string) => store.get(id) ?? null,
      upsert: (input: {
        projectId: string;
        provider: string;
        providerProjectName?: string | null;
        status: ProjectIndexRecord['status'];
        indexedAt?: string | null;
        durationMs?: number | null;
        gitCommit?: string | null;
        filesCount?: number | null;
        symbolsCount?: number | null;
        relationshipsCount?: number | null;
        error?: string | null;
        metadata?: ProjectIndexRecord['metadata'];
      }) => {
        const existing = store.get(input.projectId);
        const now = new Date().toISOString();
        const record: ProjectIndexRecord = {
          id: existing?.id ?? 'idx-1',
          projectId: input.projectId,
          provider: input.provider,
          providerProjectName: input.providerProjectName ?? null,
          status: input.status,
          indexedAt: input.indexedAt ?? null,
          durationMs: input.durationMs ?? null,
          gitCommit: input.gitCommit ?? null,
          filesCount: input.filesCount ?? null,
          symbolsCount: input.symbolsCount ?? null,
          relationshipsCount: input.relationshipsCount ?? null,
          error: input.error ?? null,
          metadata: input.metadata ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        store.set(input.projectId, record);
        return record;
      },
    } as unknown as ProjectIndexRepository;

    const projects = {
      findById: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'demo',
              path: projectPath,
              createdAt: '',
              updatedAt: '',
            }
          : null,
    } as unknown as ProjectRepository;

    provider = new CodebaseMemoryIndexerProvider(commands, indexes, projects);

    // Default: UI probe fails fast (invalid port)
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
  });

  it('health reports cliAvailable true when list_projects succeeds', async () => {
    executeMock.mockImplementation(async (req) => {
      if (req.args?.[0] === '--version') {
        return okResult('codebase-memory-mcp 0.11.0\n');
      }
      return okResult(
        JSON.stringify({
          structuredContent: { projects: [], total: 0 },
          isError: false,
        }),
      );
    });
    const health = await provider.health();
    expect(health.cliAvailable).toBe(true);
    expect(health.uiAvailable).toBe(false);
    expect(health.version).toContain('0.11.0');
  });

  it('health reports cliAvailable false when CLI fails', async () => {
    executeMock.mockResolvedValue(
      failResult('Command not found: codebase-memory-mcp'),
    );
    const health = await provider.health();
    expect(health.cliAvailable).toBe(false);
    expect(health.error).toBeTruthy();
  });

  it('health reports uiAvailable true when UI responds', async () => {
    executeMock.mockResolvedValue(
      okResult(
        JSON.stringify({
          structuredContent: { projects: [] },
          isError: false,
        }),
      ),
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as unknown as typeof fetch;
    const health = await provider.health();
    expect(health.uiAvailable).toBe(true);
  });

  it('indexes successfully and persists providerProjectName from list_projects', async () => {
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('index_repository')) {
        return okResult(
          JSON.stringify({
            structuredContent: { ok: true },
            isError: false,
          }),
        );
      }
      if (joined.includes('list_projects')) {
        return okResult(
          JSON.stringify({
            structuredContent: {
              projects: [
                {
                  name: 'cm-demo-name',
                  root_path: projectPath,
                  node_count: 12,
                  edge_count: 34,
                },
              ],
            },
            isError: false,
          }),
        );
      }
      if (joined.includes('rev-parse')) {
        return okResult('abc123deadbeef\n');
      }
      if (joined.includes('status')) {
        return okResult('');
      }
      return okResult('{}');
    });

    const result = await provider.indexProject({
      projectId: 'p1',
      projectPath,
      forceReindex: true,
    });
    expect(result.success).toBe(true);
    expect(result.providerProjectName).toBe('cm-demo-name');
    expect(result.gitCommit).toBe('abc123deadbeef');
    expect(store.get('p1')?.status).toBe('ready');
    expect(store.get('p1')?.providerProjectName).toBe('cm-demo-name');
    expect(store.get('p1')?.metadata?.workingTreeFingerprint).toBeTruthy();
  });

  it('marks failed on index CLI failure', async () => {
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse') || joined.includes('status')) {
        return okResult('');
      }
      if (joined.includes('index_repository')) {
        return failResult('index blew up');
      }
      return okResult('{}');
    });
    const result = await provider.indexProject({
      projectId: 'p1',
      projectPath,
      forceReindex: true,
    });
    expect(result.success).toBe(false);
    expect(store.get('p1')?.status).toBe('failed');
  });

  it('marks failed on timeout', async () => {
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse') || joined.includes('status')) {
        return okResult('');
      }
      return failResult('', { timedOut: true, success: false, exitCode: null });
    });
    const result = await provider.indexProject({
      projectId: 'p1',
      projectPath,
      forceReindex: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Timeout/i);
  });

  it('skips reindex when ready and forceReindex is false', async () => {
    store.set('p1', {
      id: 'idx-1',
      projectId: 'p1',
      provider: 'codebase-memory',
      providerProjectName: 'cm-demo-name',
      status: 'ready',
      indexedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 10,
      gitCommit: 'abc',
      filesCount: null,
      symbolsCount: 1,
      relationshipsCount: 1,
      error: null,
      metadata: {
        workingTreeFingerprint: 'x',
        workingTreeDirty: false,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // getProjectIndexStatus will call git — keep HEAD+fingerprint matching
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse')) {
        return okResult('abc\n');
      }
      if (joined.includes('status')) {
        // fingerprint of empty porcelain must match stored 'x' — it won't,
        // so force status path differently: we only need skip before status
        // Actually skip happens after getProjectIndexStatus which may mark stale.
        // For skip we need state === 'ready'. Fingerprint mismatch → stale → reindex.
        // Seed fingerprint of empty string:
        return okResult('');
      }
      return okResult('{}');
    });

    // Fix stored fingerprint to match empty porcelain hash
    const { createHash } = await import('node:crypto');
    const fp = createHash('sha256').update('').digest('hex').slice(0, 32);
    const existing = store.get('p1');
    if (existing) {
      existing.metadata = {
        workingTreeFingerprint: fp,
        workingTreeDirty: false,
      };
    }

    const result = await provider.indexProject({
      projectId: 'p1',
      projectPath,
      forceReindex: false,
    });
    expect(result.skipped).toBe(true);
    expect(
      executeMock.mock.calls.some((c) =>
        (c[0].args ?? []).includes('index_repository'),
      ),
    ).toBe(false);
  });

  it('reports stale when HEAD changes', async () => {
    const { createHash } = await import('node:crypto');
    const fp = createHash('sha256').update('').digest('hex').slice(0, 32);
    store.set('p1', {
      id: 'idx-1',
      projectId: 'p1',
      provider: 'codebase-memory',
      providerProjectName: 'cm-demo-name',
      status: 'ready',
      indexedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 10,
      gitCommit: 'old-head',
      filesCount: null,
      symbolsCount: null,
      relationshipsCount: null,
      error: null,
      metadata: { workingTreeFingerprint: fp, workingTreeDirty: false },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse')) {
        return okResult('new-head\n');
      }
      if (joined.includes('status')) {
        return okResult('');
      }
      return okResult('{}');
    });
    const status = await provider.getProjectIndexStatus('p1');
    expect(status.state).toBe('stale');
    expect(status.currentRevision).toBe('new-head');
  });

  it('reports stale when working tree porcelain changes', async () => {
    const { createHash } = await import('node:crypto');
    const fp = createHash('sha256').update('').digest('hex').slice(0, 32);
    store.set('p1', {
      id: 'idx-1',
      projectId: 'p1',
      provider: 'codebase-memory',
      providerProjectName: 'cm-demo-name',
      status: 'ready',
      indexedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 10,
      gitCommit: 'same-head',
      filesCount: null,
      symbolsCount: null,
      relationshipsCount: null,
      error: null,
      metadata: { workingTreeFingerprint: fp, workingTreeDirty: false },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse')) {
        return okResult('same-head\n');
      }
      if (joined.includes('status')) {
        return okResult(' M apps/local-agent/src/main.ts\n');
      }
      return okResult('{}');
    });
    const status = await provider.getProjectIndexStatus('p1');
    expect(status.state).toBe('stale');
    expect(status.workingTreeClean).toBe(false);
  });

  it('returns empty context for unknown symbol', async () => {
    store.set('p1', {
      id: 'idx-1',
      projectId: 'p1',
      provider: 'codebase-memory',
      providerProjectName: 'cm-demo-name',
      status: 'ready',
      indexedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 10,
      gitCommit: 'abc',
      filesCount: null,
      symbolsCount: null,
      relationshipsCount: null,
      error: null,
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse')) {
        return okResult('abc\n');
      }
      if (joined.includes('status')) {
        return okResult('');
      }
      if (joined.includes('search_graph')) {
        return okResult(
          JSON.stringify({
            structuredContent: { nodes: [] },
            isError: false,
          }),
        );
      }
      return okResult('{}');
    });
    const ctx = await provider.getContext({
      projectId: 'p1',
      projectPath,
      providerProjectName: 'cm-demo-name',
      symbol: 'DoesNotExistZZZ',
    });
    expect(ctx.symbols).toEqual([]);
    expect(ctx.snippets).toEqual([]);
  });

  it('maps callers, callees and snippets for a found symbol', async () => {
    store.set('p1', {
      id: 'idx-1',
      projectId: 'p1',
      provider: 'codebase-memory',
      providerProjectName: 'cm-demo-name',
      status: 'ready',
      indexedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 10,
      gitCommit: 'abc',
      filesCount: null,
      symbolsCount: null,
      relationshipsCount: null,
      error: null,
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    executeMock.mockImplementation(async (req) => {
      const joined = (req.args ?? []).join(' ');
      if (joined.includes('rev-parse')) {
        return okResult('abc\n');
      }
      if (joined.includes('status')) {
        return okResult('');
      }
      if (joined.includes('search_graph')) {
        return okResult(
          JSON.stringify({
            structuredContent: {
              cols: ['name', 'label', 'lines', 'in', 'out'],
              groups: [
                {
                  qn_prefix: 'demo.src.foo',
                  file: 'src/foo.ts',
                  rows: [['Foo', 'Function', '10-20', 1, 1]],
                },
              ],
            },
            isError: false,
          }),
        );
      }
      if (joined.includes('trace_path')) {
        return okResult(
          JSON.stringify({
            structuredContent: {
              callers: {
                cols: ['name', 'hop', 'test'],
                groups: [
                  {
                    qn_prefix: 'demo.src.bar',
                    file: 'src/bar.ts',
                    rows: [['Bar', 1, false]],
                  },
                ],
              },
              callees: {
                cols: ['name', 'hop', 'test'],
                groups: [
                  {
                    qn_prefix: 'demo.src.baz',
                    file: 'src/baz.ts',
                    rows: [['Baz', 1, false]],
                  },
                ],
              },
            },
            isError: false,
          }),
        );
      }
      if (joined.includes('get_code_snippet')) {
        return okResult(
          JSON.stringify({
            structuredContent: {
              source: 'function Foo() { return 1; }',
              file_path: 'src/foo.ts',
              start_line: 10,
              end_line: 12,
            },
            isError: false,
          }),
        );
      }
      return okResult('{}');
    });

    const ctx = await provider.getContext({
      projectId: 'p1',
      projectPath,
      providerProjectName: 'cm-demo-name',
      symbol: 'Foo',
    });
    expect(ctx.target?.name).toBe('Foo');
    expect(ctx.relations.some((r) => r.kind === 'caller' && r.from === 'Bar')).toBe(
      true,
    );
    expect(ctx.relations.some((r) => r.kind === 'callee' && r.to === 'Baz')).toBe(
      true,
    );
    expect(ctx.snippets[0]?.content).toContain('function Foo');
    const fileContext = await provider.getContext({
      projectId: 'p1', projectPath, providerProjectName: 'cm-demo-name',
      file: 'src/foo.ts', line: 12,
    });
    expect(fileContext.target?.name).toBe('Foo');
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['--file-pattern', 'src/foo.ts']),
    }));
  });

  it('returns not_indexed when no metadata row', async () => {
    const status = await provider.getProjectIndexStatus('unknown');
    expect(status.state).toBe('not_indexed');
  });

  it('returns failed state from persisted metadata', async () => {
    store.set('p1', {
      id: 'idx-1',
      projectId: 'p1',
      provider: 'codebase-memory',
      providerProjectName: null,
      status: 'failed',
      indexedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 3,
      gitCommit: null,
      filesCount: null,
      symbolsCount: null,
      relationshipsCount: null,
      error: 'boom',
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const status = await provider.getProjectIndexStatus('p1');
    expect(status.state).toBe('failed');
    expect(status.error).toBe('boom');
  });
});
