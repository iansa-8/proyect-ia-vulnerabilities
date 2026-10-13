import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  PipelineContext,
  PipelineStep,
  PipelineStepResult,
  PlatformEvent,
  ProjectProfile,
  ProjectRecord,
} from '@amp/core';
import { SequentialPipelineEngine } from './sequential-engine';

function emptyProfile(): ProjectProfile {
  return { hasDocker: false, hasSonar: false };
}

function makeProject(id = 'p1'): ProjectRecord {
  return {
    id,
    name: 'demo',
    path: 'C:\\tmp\\demo',
    profile: emptyProfile(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeContext(runId = 'r1'): PipelineContext {
  const project = makeProject();
  return {
    runId,
    project,
    projectProfile: project.profile ?? emptyProfile(),
    data: new Map(),
  };
}

function okStep(
  id: string,
  name: string,
  orderLog: string[],
  rollbackLog?: string[],
): PipelineStep {
  return {
    id,
    name,
    async execute(context: PipelineContext): Promise<PipelineStepResult> {
      orderLog.push(id);
      const startedAt = new Date().toISOString();
      context.data.set(`ran:${id}`, true);
      return {
        stepId: id,
        status: 'success',
        startedAt,
        finishedAt: startedAt,
        durationMs: 1,
      };
    },
    async rollback(): Promise<void> {
      rollbackLog?.push(id);
    },
  };
}

function failStep(id: string, name: string, orderLog: string[]): PipelineStep {
  return {
    id,
    name,
    async execute(): Promise<PipelineStepResult> {
      orderLog.push(id);
      const startedAt = new Date().toISOString();
      return {
        stepId: id,
        status: 'failed',
        startedAt,
        finishedAt: startedAt,
        durationMs: 2,
        error: `${id} failed`,
      };
    },
  };
}

describe('SequentialPipelineEngine', () => {
  it('registers and runs a single step', async () => {
    const engine = new SequentialPipelineEngine();
    const order: string[] = [];
    engine.registerStep(okStep('noop', 'No-op', order));
    const result = await engine.runStep('noop', makeContext());
    assert.equal(result.status, 'success');
    assert.equal(engine.getSteps().length, 1);
  });

  it('rejects duplicate step ids', () => {
    const engine = new SequentialPipelineEngine();
    const step = okStep('a', 'A', []);
    engine.registerStep(step);
    assert.throws(() => engine.registerStep(step), /already registered/);
  });

  it('executes steps in definition order and succeeds', async () => {
    const engine = new SequentialPipelineEngine();
    const order: string[] = [];
    engine.registerStep(okStep('s1', 'One', order));
    engine.registerStep(okStep('s2', 'Two', order));
    engine.registerStep(okStep('s3', 'Three', order));
    engine.registerDefinition({
      id: 'demo',
      name: 'Demo',
      description: 'test',
      rollbackPolicy: 'none',
      steps: [{ stepId: 's1' }, { stepId: 's2' }, { stepId: 's3' }],
    });

    const result = await engine.run('demo', makeContext());
    assert.deepEqual(order, ['s1', 's2', 's3']);
    assert.equal(result.status, 'success');
    assert.equal(result.steps.length, 3);
    assert.ok(result.steps.every((s) => s.status === 'success'));
    assert.ok(result.durationMs >= 0);
    assert.ok(result.startedAt);
    assert.ok(result.finishedAt);
  });

  it('fails when a step fails and does not run later steps', async () => {
    const engine = new SequentialPipelineEngine();
    const order: string[] = [];
    engine.registerStep(okStep('s1', 'One', order));
    engine.registerStep(failStep('s2', 'Two', order));
    engine.registerStep(okStep('s3', 'Three', order));
    engine.registerDefinition({
      id: 'fail-demo',
      name: 'Fail',
      description: 'test',
      rollbackPolicy: 'none',
      steps: [{ stepId: 's1' }, { stepId: 's2' }, { stepId: 's3' }],
    });

    const result = await engine.run('fail-demo', makeContext());
    assert.deepEqual(order, ['s1', 's2']);
    assert.equal(result.status, 'failed');
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1].status, 'failed');
    assert.match(result.error ?? '', /s2 failed/);
  });

  it('records correct statuses and duration', async () => {
    const engine = new SequentialPipelineEngine();
    engine.registerStep(okStep('only', 'Only', []));
    engine.registerDefinition({
      id: 'dur',
      name: 'Dur',
      description: 'd',
      rollbackPolicy: 'none',
      steps: [{ stepId: 'only' }],
    });
    const result = await engine.run('dur', makeContext('run-dur'));
    assert.equal(result.steps[0].status, 'success');
    assert.equal(typeof result.steps[0].durationMs, 'number');
    assert.ok((result.steps[0].durationMs ?? -1) >= 0);
  });

  it('rolls back successful steps in reverse order on onFailure', async () => {
    const engine = new SequentialPipelineEngine();
    const order: string[] = [];
    const rollbacks: string[] = [];
    engine.registerStep(okStep('a', 'A', order, rollbacks));
    engine.registerStep(okStep('b', 'B', order, rollbacks));
    engine.registerStep(failStep('c', 'C', order));
    engine.registerDefinition({
      id: 'rb',
      name: 'RB',
      description: 'd',
      rollbackPolicy: 'onFailure',
      steps: [{ stepId: 'a' }, { stepId: 'b' }, { stepId: 'c' }],
    });

    const result = await engine.run('rb', makeContext());
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.deepEqual(rollbacks, ['b', 'a']);
    assert.equal(result.status, 'failed');
    assert.equal(result.steps[0].status, 'rolled_back');
    assert.equal(result.steps[1].status, 'rolled_back');
    assert.equal(result.steps[2].status, 'failed');
  });

  it('policy none does not call rollback', async () => {
    const engine = new SequentialPipelineEngine();
    const order: string[] = [];
    const rollbacks: string[] = [];
    engine.registerStep(okStep('a', 'A', order, rollbacks));
    engine.registerStep(failStep('b', 'B', order));
    engine.registerDefinition({
      id: 'no-rb',
      name: 'NoRB',
      description: 'd',
      rollbackPolicy: 'none',
      steps: [{ stepId: 'a' }, { stepId: 'b' }],
    });

    await engine.run('no-rb', makeContext());
    assert.deepEqual(rollbacks, []);
  });

  it('emits typed pipeline events', async () => {
    const engine = new SequentialPipelineEngine();
    const events: PlatformEvent['type'][] = [];
    engine.registerStep(okStep('a', 'A', []));
    engine.registerStep(failStep('b', 'B', []));
    engine.registerDefinition({
      id: 'ev',
      name: 'Ev',
      description: 'd',
      rollbackPolicy: 'none',
      steps: [{ stepId: 'a' }, { stepId: 'b' }],
    });

    await engine.run('ev', makeContext(), {
      emit: (event) => {
        events.push(event.type);
      },
    });

    assert.deepEqual(events, [
      'pipeline.started',
      'step.started',
      'step.completed',
      'step.started',
      'step.failed',
      'pipeline.failed',
      'pipeline.completed',
    ]);
  });
});
