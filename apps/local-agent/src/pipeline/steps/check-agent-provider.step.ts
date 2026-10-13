import { Inject, Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import type { AgentProvider } from '@amp/providers';
import { AGENT_PROVIDER } from '../../providers/tokens';

@Injectable()
export class CheckAgentProviderStep implements PipelineStep {
  readonly id = 'check-agent-provider';
  readonly name = 'Check Agent Provider';
  constructor(@Inject(AGENT_PROVIDER) private readonly agent: AgentProvider) {}
  async execute(_context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const health = await this.agent.health();
    const supported = this.agent.capabilities.includes('propose-fix');
    const finished = new Date();
    const ok = health.available && supported;
    return {
      stepId: this.id,
      status: ok ? 'success' : 'failed',
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      result: { provider: health.provider, version: health.version, available: health.available, capabilities: health.capabilities },
      error: ok ? undefined : health.available ? 'UNSUPPORTED_CAPABILITY' : 'AGENT_UNAVAILABLE',
    };
  }
}
