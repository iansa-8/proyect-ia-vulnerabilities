import { IndexProjectStep } from './index-project.step';
import { CheckIndexerStep } from './check-indexer.step';
import type { IndexerProvider, IndexProjectResult } from '@amp/providers';
import type { PipelineContext } from '@amp/core';
import type { EventsGateway } from '../../events/events.gateway';

function makeContext(): PipelineContext {
  return {
    runId: 'run-1',
    project: {
      id: 'p1',
      name: 'demo',
      path: 'C:\\tmp\\demo',
      profile: { hasDocker: false, hasSonar: false },
      createdAt: '',
      updatedAt: '',
    },
    projectProfile: { hasDocker: false, hasSonar: false },
    data: new Map(),
  };
}

describe('IndexProjectStep', () => {
  it('succeeds and emits index.completed', async () => {
    const indexResult: IndexProjectResult = {
      success: true,
      provider: 'codebase-memory',
      providerProjectName: 'demo',
      indexedAt: new Date().toISOString(),
      durationMs: 12,
    };
    const indexer: IndexerProvider = {
      name: 'codebase-memory',
      health: async () => ({
        provider: 'codebase-memory',
        cliAvailable: true,
        uiAvailable: false,
      }),
      indexProject: jest.fn().mockResolvedValue(indexResult),
      getProjectIndexStatus: jest.fn(),
      getContext: jest.fn(),
    };
    const emitEvent = jest.fn();
    const events = { emitEvent } as unknown as EventsGateway;
    const step = new IndexProjectStep(indexer, events);
    const result = await step.execute(makeContext());
    expect(result.status).toBe('success');
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'index.started' }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'index.completed' }),
    );
  });

  it('fails and emits index.failed', async () => {
    const indexer: IndexerProvider = {
      name: 'codebase-memory',
      health: async () => ({
        provider: 'codebase-memory',
        cliAvailable: true,
        uiAvailable: false,
      }),
      indexProject: jest.fn().mockResolvedValue({
        success: false,
        provider: 'codebase-memory',
        indexedAt: new Date().toISOString(),
        durationMs: 1,
        error: 'nope',
      }),
      getProjectIndexStatus: jest.fn(),
      getContext: jest.fn(),
    };
    const emitEvent = jest.fn();
    const events = { emitEvent } as unknown as EventsGateway;
    const step = new IndexProjectStep(indexer, events);
    const result = await step.execute(makeContext());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('nope');
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'index.failed' }),
    );
  });
});

describe('CheckIndexerStep', () => {
  it('fails when cliAvailable is false', async () => {
    const indexer: IndexerProvider = {
      name: 'codebase-memory',
      health: async () => ({
        provider: 'codebase-memory',
        cliAvailable: false,
        uiAvailable: false,
        error: 'CLI missing',
      }),
      indexProject: jest.fn(),
      getProjectIndexStatus: jest.fn(),
      getContext: jest.fn(),
    };
    const step = new CheckIndexerStep(indexer);
    const result = await step.execute(makeContext());
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/CLI missing|no disponible/i);
  });

  it('succeeds when cliAvailable is true', async () => {
    const indexer: IndexerProvider = {
      name: 'codebase-memory',
      health: async () => ({
        provider: 'codebase-memory',
        cliAvailable: true,
        uiAvailable: true,
        version: '0.11.0',
      }),
      indexProject: jest.fn(),
      getProjectIndexStatus: jest.fn(),
      getContext: jest.fn(),
    };
    const step = new CheckIndexerStep(indexer);
    const result = await step.execute(makeContext());
    expect(result.status).toBe('success');
  });
});
