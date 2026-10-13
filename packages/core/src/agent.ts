export type AgentTaskType =
  | 'analyze'
  | 'propose-fix'
  | 'apply-fix'
  | 'fix'
  | 'refactor'
  | 'migrate'
  | 'document'
  | 'custom';

export type AgentCapability =
  | 'propose-fix'
  | 'apply-fix'
  | 'analyze'
  | 'generate-tests';

export type AgentProposalRisk = 'low' | 'medium' | 'high' | 'unknown';

export const AGENT_ERROR_CODES = [
  'AGENT_UNAVAILABLE',
  'AGENT_TIMEOUT',
  'INVALID_AGENT_RESPONSE',
  'AGENT_EXECUTION_FAILED',
  'AGENT_WRITE_DETECTED',
  'NO_FILES_CHANGED',
  'UNEXPECTED_FILE_CHANGE',
  'PROPOSAL_STALE',
  'CONTEXT_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export const STRUCTURED_PATCH_VERSION = 1 as const;

/** A reviewed, deterministic edit against a relative repository file. */
export interface PatchLineEdit {
  file: string;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  expectedText: string;
  replacement: string;
}

/** Conservative checks that must still hold immediately before application. */
export interface PatchPrecondition {
  file: string;
  forbiddenPatterns: string[];
}

export interface StructuredPatch {
  version: typeof STRUCTURED_PATCH_VERSION;
  edits: PatchLineEdit[];
  preconditions: PatchPrecondition[];
}

export interface AgentProposal {
  provider: string;
  taskId: string;
  summary: string;
  diagnosis?: string;
  proposedChanges: Array<{
    file: string;
    description: string;
    rationale?: string;
  }>;
  /** Present only when the proposal carries an exact, platform-applicable patch. */
  patch?: StructuredPatch;
  affectedFiles: string[];
  /** Recommendation from the agent; platform policy remains authoritative. */
  agentSuggestedRisk: AgentProposalRisk;
  validationPlan: string[];
  assumptions?: string[];
  warnings?: string[];
  rawResponseAvailable?: boolean;
  remediationStrategy?: 'local' | 'llm' | 'agent' | 'manual';
  remediationReason?: string;
  estimatedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** If true, the LLM determined the issue requires agentic multi-file/refactor handling. */
  requiresAgent?: boolean;
  /** Human-readable reason why agent escalation is needed. */
  escalationReason?: string;
}

export interface AgentHealth {
  available: boolean;
  provider: string;
  version?: string;
  capabilities: AgentCapability[];
  error?: string;
}

export interface AgentIssueContext {
  provider: string;
  id: string;
  rule?: string;
  severity?: string;
  type?: string;
  message: string;
  file?: string;
  line?: number;
}

export interface AgentCodeContext {
  indexProvider?: string;
  indexState?: string;
  targetSymbol?: string;
  files: string[];
  symbols?: string[];
  snippets?: Array<{
    file: string;
    startLine?: number;
    endLine?: number;
    content: string;
  }>;
  callers?: string[];
  callees?: string[];
  tests?: string[];
  warnings?: string[];
}

export interface AgentExecutionTrace {
  indexProvider?: string;
  indexState?: string;
  targetSymbol?: string;
  filesIncluded: string[];
  symbolsIncluded: number;
  snippetsIncluded: number;
  snippetChars: number;
  promptChars: number;
  promptSha256: string;
  /** Exact sanitized prompt sent through stdin, bounded for local audit UI. */
  promptPreview: string;
  promptPreviewTruncated: boolean;
  estimatedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  strategy?: 'local' | 'llm' | 'agent' | 'manual';
  reason?: string;
}

export interface AgentTask {
  id?: string;
  type: AgentTaskType;
  objective?: string;
  project?: {
    id: string;
    path: string;
    runtime?: string;
    framework?: string;
  };
  issue?: AgentIssueContext;
  context: Record<string, unknown> | AgentCodeContext;
  constraints: string[];
  projectPath: string;
  validationCommands?: {
    build?: string;
    unit?: string;
    e2e?: string;
    startup?: string;
  };
  proposalId?: string;
  approvedProposal?: AgentProposal;
  allowedFiles?: string[];
}

export type RunOwnedChangeType = 'modified' | 'created' | 'deleted' | 'renamed';

export interface RunOwnedChange {
  file: string;
  changeType: RunOwnedChangeType;
  existedBefore: boolean;
  baselineHash?: string;
  afterHash?: string;
}

export interface AgentApplyResult {
  success: boolean;
  provider: string;
  providerVersion?: string;
  proposalId: string;
  changedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  summary?: string;
  durationMs: number;
  warnings?: string[];
  error?: { code: AgentErrorCode; message: string };
}

export interface AgentResult {
  success: boolean;
  summary: string;
  touchedFiles: string[];
  output?: string;
  provider?: string;
  providerVersion?: string;
  durationMs?: number;
  proposal?: AgentProposal;
  executionTrace?: AgentExecutionTrace;
  error?: { code: AgentErrorCode; message: string };
  writeDetection?: {
    unchanged: boolean;
    beforeFingerprint: string;
    afterFingerprint: string;
  };
}
