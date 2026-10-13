import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeProjectProfile, type ProjectProfile } from './project';

describe('mergeProjectProfile', () => {
  const detected: ProjectProfile = {
    hasDocker: false,
    hasSonar: false,
    buildCommand: 'npm run build',
    testCommand: 'npm run test',
  };

  it('keeps detected commands when no overrides', () => {
    const merged = mergeProjectProfile(detected);
    assert.equal(merged.buildCommand, 'npm run build');
    assert.equal(merged.testCommand, 'npm run test');
  });

  it('applies overrides and clears with empty string', () => {
    const merged = mergeProjectProfile(detected, {
      buildCommand: 'yarn build',
      testCommand: '',
    });
    assert.equal(merged.buildCommand, 'yarn build');
    assert.equal(merged.testCommand, undefined);
  });
});
