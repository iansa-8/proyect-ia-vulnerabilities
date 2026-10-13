import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoOpAgentProvider } from './noop-agent';
import { InMemoryIndexerProvider } from './in-memory-indexer';

describe('NoOpAgentProvider', () => {
  it('returns success without touching files', async () => {
    const agent = new NoOpAgentProvider();
    const result = await agent.execute({
      type: 'analyze',
      objective: 'demo',
      context: {},
      constraints: [],
      projectPath: 'C:\\tmp\\demo',
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.touchedFiles, []);
  });
});

describe('InMemoryIndexerProvider', () => {
  it('reports not_indexed until indexed', async () => {
    const indexer = new InMemoryIndexerProvider();
    const before = await indexer.getProjectIndexStatus('p1');
    assert.equal(before.state, 'not_indexed');
    const result = await indexer.indexProject({
      projectId: 'p1',
      projectPath: 'C:\\tmp\\demo',
    });
    assert.equal(result.success, true);
    const after = await indexer.getProjectIndexStatus('p1');
    assert.equal(after.state, 'ready');
  });

  it('skips reindex when ready and forceReindex is false', async () => {
    const indexer = new InMemoryIndexerProvider();
    await indexer.indexProject({
      projectId: 'p1',
      projectPath: 'C:\\tmp\\demo',
    });
    const second = await indexer.indexProject({
      projectId: 'p1',
      projectPath: 'C:\\tmp\\demo',
      forceReindex: false,
    });
    assert.equal(second.skipped, true);
  });

  it('returns empty context for unknown symbol after index', async () => {
    const indexer = new InMemoryIndexerProvider();
    await indexer.indexProject({
      projectId: 'p1',
      projectPath: 'C:\\tmp\\demo',
    });
    const ctx = await indexer.getContext({
      projectId: 'p1',
      projectPath: 'C:\\tmp\\demo',
      symbol: 'Foo',
    });
    assert.equal(ctx.symbols.length, 1);
    assert.equal(ctx.symbols[0].name, 'Foo');
  });

  it('health is always available for stub', async () => {
    const indexer = new InMemoryIndexerProvider();
    const health = await indexer.health();
    assert.equal(health.cliAvailable, true);
    assert.equal(health.uiAvailable, false);
  });
});
