import type { AgentCodeContext, AgentProposal, AgentResult, AgentTask } from './agent';
import type { ProjectProfile } from './project';
import type { QualityIssue } from './quality';

export type RemediationStrategy = 'local' | 'llm' | 'agent' | 'manual';

export interface RemediationDecision {
  strategy: RemediationStrategy;
  reason: string;
  confidence?: number;
}

export interface RemediationInput {
  issue: QualityIssue;
  projectProfile: ProjectProfile;
  context: AgentCodeContext;
}

export interface LLMHealth {
  available: boolean;
  provider: string;
  model?: string;
  error?: string;
}

export interface LLMUsage {
  estimatedInputTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LLMProposalResult extends AgentResult {
  proposal?: AgentProposal;
  model?: string;
  usage?: LLMUsage;
}

export interface BoundedProposalContext {
  context: AgentCodeContext;
  estimatedInputTokens: number;
  warnings: string[];
}

export type LLMProposalTask = AgentTask;
