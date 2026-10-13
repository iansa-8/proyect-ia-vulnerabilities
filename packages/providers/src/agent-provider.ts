import type {
  AgentCapability,
  AgentHealth,
  AgentResult,
  AgentTask,
} from '@amp/core';

/**
 * Coding agent abstraction. Cursor, Codex, etc. implement this.
 * Core MUST call agentProvider.execute(task) — never vendor-specific APIs.
 */
export interface AgentProvider {
  readonly name: string;
  readonly capabilities: readonly AgentCapability[];
  health(): Promise<AgentHealth>;
  execute(task: AgentTask): Promise<AgentResult>;
  proposeFix(task: AgentTask): Promise<AgentResult>;
  applyFix(task: AgentTask): Promise<AgentResult>;
}
