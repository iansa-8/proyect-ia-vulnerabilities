import type {
  IndexContextQuery,
  IndexContextResult,
  IndexerHealth,
  IndexerProvider,
  IndexProjectInput,
  IndexProjectResult,
  ProjectIndexStatus,
} from './indexer-provider';

/**
 * Safe in-memory stub indexer.
 * Used when INDEXER_PROVIDER is not codebase-memory, and in unit tests.
 * Does not call any external CLI.
 */
export class InMemoryIndexerProvider implements IndexerProvider {
  readonly name = 'in-memory-indexer';
  private readonly indexed = new Map<
    string,
    { projectPath: string; indexedAt: string }
  >();

  async health(): Promise<IndexerHealth> {
    return {
      provider: this.name,
      cliAvailable: true,
      uiAvailable: false,
    };
  }

  async indexProject(input: IndexProjectInput): Promise<IndexProjectResult> {
    const started = Date.now();
    const existing = this.indexed.get(input.projectId);
    if (existing && !input.forceReindex) {
      return {
        success: true,
        provider: this.name,
        providerProjectName: `stub:${input.projectId}`,
        indexedAt: existing.indexedAt,
        durationMs: Date.now() - started,
        skipped: true,
      };
    }
    const indexedAt = new Date().toISOString();
    this.indexed.set(input.projectId, {
      projectPath: input.projectPath,
      indexedAt,
    });
    return {
      success: true,
      provider: this.name,
      providerProjectName: `stub:${input.projectId}`,
      indexedAt,
      durationMs: Date.now() - started,
      stats: { files: 0, symbols: 0, relationships: 0 },
    };
  }

  async getProjectIndexStatus(projectId: string): Promise<ProjectIndexStatus> {
    const existing = this.indexed.get(projectId);
    if (!existing) {
      return {
        projectId,
        provider: this.name,
        state: 'not_indexed',
      };
    }
    return {
      projectId,
      provider: this.name,
      state: 'ready',
      providerProjectName: `stub:${projectId}`,
      indexedAt: existing.indexedAt,
      workingTreeClean: true,
    };
  }

  async getContext(query: IndexContextQuery): Promise<IndexContextResult> {
    const empty: IndexContextResult = {
      query,
      symbols: [],
      relatedFiles: [],
      relations: [],
      tests: [],
      snippets: [],
    };
    if (!this.indexed.has(query.projectId)) {
      return empty;
    }
    if (!query.symbol) {
      return empty;
    }
    const symbol = {
      name: query.symbol,
      filePath: query.file,
      kind: 'Function',
    };
    return {
      query,
      target: symbol,
      symbols: [symbol],
      relatedFiles: query.file ? [query.file] : [],
      relations: [],
      tests: [],
      snippets: [
        {
          symbolName: query.symbol,
          filePath: query.file,
          content: `// stub snippet for ${query.symbol}`,
        },
      ],
    };
  }
}
