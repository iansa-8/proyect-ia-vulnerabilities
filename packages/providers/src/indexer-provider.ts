/**
 * Knowledge index over a codebase.
 * Pipeline Engine depends only on this contract — never on Codebase Memory internals.
 */

export const PROJECT_INDEX_STATES = [
  'not_indexed',
  'indexing',
  'ready',
  'failed',
  'stale',
] as const;

export type ProjectIndexState = (typeof PROJECT_INDEX_STATES)[number];

export function isProjectIndexState(value: string): value is ProjectIndexState {
  return (PROJECT_INDEX_STATES as readonly string[]).includes(value);
}

export interface IndexerHealth {
  provider: string;
  /** True when the configured indexer backend can be invoked. */
  cliAvailable: boolean;
  /** Optional graph UI reachability — false does NOT mean indexer is down. */
  uiAvailable: boolean;
  version?: string;
  error?: string;
}

export interface IndexProjectInput {
  projectId: string;
  projectPath: string;
  forceReindex?: boolean;
}

export interface IndexProjectStats {
  files?: number;
  symbols?: number;
  relationships?: number;
}

export interface IndexProjectResult {
  success: boolean;
  provider: string;
  providerProjectName?: string;
  indexedAt: string;
  durationMs: number;
  gitCommit?: string;
  stats?: IndexProjectStats;
  /** Present when skipped because already ready and forceReindex was false. */
  skipped?: boolean;
  error?: string;
}

export interface ProjectIndexStatus {
  projectId: string;
  provider: string;
  state: ProjectIndexState;
  providerProjectName?: string;
  indexedAt?: string;
  durationMs?: number;
  indexedRevision?: string;
  currentRevision?: string;
  workingTreeClean?: boolean;
  filesCount?: number;
  symbolsCount?: number;
  relationshipsCount?: number;
  error?: string;
}

export type CodeRelationKind =
  | 'caller'
  | 'callee'
  | 'dependency'
  | 'test'
  | 'related';

export interface CodeSymbol {
  name: string;
  qualifiedName?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface CodeRelation {
  kind: CodeRelationKind;
  from: string;
  to: string;
  evidence?: string;
}

export interface CodeSnippet {
  symbolName?: string;
  qualifiedName?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  content: string;
}

/**
 * Extensible context query. MVP: symbol and/or file.
 * Future: text / impact / architecture / tests without breaking callers.
 */
export interface IndexContextQuery {
  projectId: string;
  projectPath: string;
  providerProjectName?: string;
  symbol?: string;
  file?: string;
  line?: number;
  kind?: 'symbol' | 'text' | 'impact' | 'architecture' | 'tests';
}

export interface IndexContextResult {
  query: IndexContextQuery;
  target?: CodeSymbol;
  symbols: CodeSymbol[];
  relatedFiles: string[];
  relations: CodeRelation[];
  tests: CodeSymbol[];
  snippets: CodeSnippet[];
}

/**
 * Indexer capability boundary.
 * Implementations: InMemoryIndexerProvider (stub) | CodebaseMemoryIndexerProvider (CLI).
 */
export interface IndexerProvider {
  readonly name: string;
  health(): Promise<IndexerHealth>;
  indexProject(input: IndexProjectInput): Promise<IndexProjectResult>;
  getProjectIndexStatus(projectId: string): Promise<ProjectIndexStatus>;
  getContext(query: IndexContextQuery): Promise<IndexContextResult>;
}
