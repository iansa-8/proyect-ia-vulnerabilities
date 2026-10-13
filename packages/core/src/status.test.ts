import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertStepTransition, mapStepStatus } from './status';

describe('mapStepStatus', () => {
  it('accepts known statuses', () => {
    assert.equal(mapStepStatus('pending'), 'pending');
    assert.equal(mapStepStatus('rolled_back'), 'rolled_back');
  });

  it('rejects unknown statuses', () => {
    assert.equal(mapStepStatus('done'), null);
  });
});

describe('assertStepTransition', () => {
  it('allows pending → running', () => {
    assert.equal(assertStepTransition('pending', 'running'), true);
  });

  it('rejects success → running', () => {
    assert.equal(assertStepTransition('success', 'running'), false);
  });
});
