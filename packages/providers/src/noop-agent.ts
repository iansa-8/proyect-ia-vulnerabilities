import type { AgentResult, AgentTask } from '@amp/core';
import type { AgentProvider } from './agent-provider';

/** Placeholder agent — never mutates a real project. */
export class NoOpAgentProvider implements AgentProvider {
  readonly name = 'noop-agent';
  readonly capabilities = [] as const;

  async health() {
    return {
      available: true,
      provider: this.name,
      capabilities: [],
    };
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      summary: `No-op agent acknowledged task type="${task.type}" (placeholder).`,
      touchedFiles: [],
      output: undefined,
    };
  }

  async proposeFix(task: AgentTask): Promise<AgentResult> {
    void task;
    return {
      success: false,
      summary: 'The configured agent does not support fix proposals.',
      touchedFiles: [],
      provider: this.name,
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Agent capability propose-fix is not available',
      },
    };
  }

  async applyFix(task: AgentTask): Promise<AgentResult> {
    void task;
    return {
      success: false,
      summary: 'The configured agent does not support applying fixes.',
      touchedFiles: [],
      provider: this.name,
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Agent capability apply-fix is not available',
      },
    };
  }
}
