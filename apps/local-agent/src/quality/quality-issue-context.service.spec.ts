import type { QualityIssue } from '@amp/core';
import type { IndexerProvider } from '@amp/providers';
import type { CodeContextService } from '../indexer/code-context.service';
import type { ProjectIndexRepository } from '../persistence/project-index.repository';
import type { ProjectRepository } from '../persistence/project.repository';
import { QualityIssueContextService } from './quality-issue-context.service';

describe('QualityIssueContextService', () => {
  const issue: QualityIssue = {
    id: 'ISSUE-1',
    provider: 'sonar',
    rule: 'typescript:S1',
    severity: 'MAJOR',
    message: 'Unused',
    file: 'src/foo.ts',
    line: 10,
  };

  function build(opts: {
    indexState?: string;
    liveState?: string;
    contextResult?: {
      target?: { name: string; startLine?: number; endLine?: number };
      symbols: Array<{ name: string; startLine?: number; endLine?: number }>;
      snippets: Array<{ content: string }>;
    };
    throwOnContext?: boolean;
  }) {
    const projects = {
      findById: jest.fn().mockReturnValue({
        id: 'p1',
        path: 'C:\\tmp\\demo',
      }),
    } as unknown as ProjectRepository;

    const indexes = {
      findByProjectId: jest.fn().mockReturnValue(
        opts.indexState
          ? {
              status: opts.indexState,
              providerProjectName: 'demo',
            }
          : null,
      ),
    } as unknown as ProjectIndexRepository;

    const codeContext = {
      getContext: jest.fn().mockImplementation(async () => {
        if (opts.throwOnContext) {
          throw new Error('indexer down');
        }
        return {
          query: { projectId: 'p1', projectPath: 'C:\\tmp\\demo', file: issue.file },
          target: opts.contextResult?.target,
          symbols: opts.contextResult?.symbols ?? [],
          relatedFiles: [],
          relations: [],
          tests: [],
          snippets: opts.contextResult?.snippets ?? [],
        };
      }),
    } as unknown as CodeContextService;

    const service = new QualityIssueContextService(
      codeContext,
      projects,
      indexes,
      opts.liveState ? { getProjectIndexStatus: jest.fn().mockResolvedValue({ state: opts.liveState }) } as unknown as IndexerProvider : undefined,
    );
    return { service, codeContext };
  }

  it('resolves symbol when indexer returns a covering match', async () => {
    const { service, codeContext } = build({
      indexState: 'ready',
      contextResult: {
        symbols: [
          { name: 'foo', startLine: 1, endLine: 5 },
          { name: 'bar', startLine: 8, endLine: 20 },
        ],
        snippets: [{ content: 'function bar() {}' }],
      },
    });

    const result = await service.resolve('p1', issue);
    expect(codeContext.getContext).toHaveBeenCalled();
    expect(result.codeContext?.target?.name).toBe('bar');
    expect(result.warnings).toEqual([]);
  });

  it('does not invent a symbol when indexer has no match', async () => {
    const { service } = build({
      indexState: 'ready',
      contextResult: { symbols: [], snippets: [] },
    });
    const result = await service.resolve('p1', issue);
    expect(result.warnings).toContain('No se pudo resolver el símbolo.');
    expect(result.issue.file).toBe('src/foo.ts');
    expect(result.issue.line).toBe(10);
  });

  it('warns when index is STALE and still returns issue', async () => {
    const { service } = build({
      indexState: 'stale',
      contextResult: {
        symbols: [{ name: 'bar', startLine: 8, endLine: 20 }],
        snippets: [{ content: 'x' }],
      },
    });
    const result = await service.resolve('p1', issue);
    expect(result.indexState).toBe('stale');
    expect(result.warnings).toContain(
      'El índice de código está desactualizado. El contexto puede no coincidir con el código actual.',
    );
    expect(result.issue.id).toBe('ISSUE-1');
  });

  it('uses live stale state without blocking context and selects the smallest covering symbol', async () => {
    const { service, codeContext } = build({
      indexState: 'ready', liveState: 'stale',
      contextResult: { symbols: [{ name: 'Class', startLine: 1, endLine: 200 }, { name: 'method', startLine: 9, endLine: 12 }], snippets: [{ content: 'method() {}' }] },
    });
    const result = await service.resolve('p1', issue);
    expect(result.indexState).toBe('stale');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.codeContext?.target?.name).toBe('method');
    expect(codeContext.getContext).toHaveBeenCalledWith(expect.objectContaining({ file: issue.file, line: issue.line }));
  });

  it('does not couple to a concrete Sonar provider', async () => {
    const { service, codeContext } = build({
      indexState: 'ready',
      contextResult: { symbols: [], snippets: [] },
    });
    await service.resolve('p1', { ...issue, provider: 'other-quality' });
    expect(codeContext.getContext).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'src/foo.ts' }),
    );
  });
});
