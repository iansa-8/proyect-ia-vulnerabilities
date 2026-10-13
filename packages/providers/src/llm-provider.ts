import type { LLMHealth, LLMProposalResult, LLMProposalTask } from '@amp/core';

/** Reasoning-only model boundary. Implementations must never modify the repository. */
export interface LLMProvider {
  readonly name: string;
  health(): Promise<LLMHealth>;
  proposeFix(task: LLMProposalTask): Promise<LLMProposalResult>;
}
