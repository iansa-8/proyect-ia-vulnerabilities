import type { AgentTask, QualityIssue } from '@amp/core';
import { DeterministicRemediator } from './deterministic-remediator.service';

const issue: QualityIssue = {
  id: 'issue-1',
  provider: 'sonar',
  rule: 'typescript:S2933',
  severity: 'MINOR',
  message: 'Add readonly to this field.',
  file: 'src/a.ts',
  line: 10,
};

function task(content: string, startLine = 10): AgentTask {
  return {
    id: 'task-1',
    type: 'propose-fix',
    projectPath: 'C:\\repo',
    issue,
    context: {
      files: ['src/a.ts'],
      targetSymbol: 'A.hola',
      snippets: [{ file: 'src/a.ts', startLine, endLine: startLine, content }],
    },
    constraints: [],
    validationCommands: { build: 'npm run build' },
  };
}

describe('DeterministicRemediator', () => {
  it('creates an exact S2933 patch with a reassignment precondition', () => {
    const result = new DeterministicRemediator().propose(
      task('private hola: string;'),
      'S2933 has a conservative local remediation.',
      0,
    );

    expect(result).toMatchObject({ success: true, provider: 'local' });
    expect(result.proposal?.patch).toEqual({
      version: 1,
      edits: [{
        file: 'src/a.ts', startLine: 10, endLine: 10,
        expectedText: 'private hola: string;', replacement: 'private readonly hola: string;',
      }],
      preconditions: [{
        file: 'src/a.ts',
        forbiddenPatterns: [expect.stringContaining('hola')],
      }],
    });
    const pattern = new RegExp(result.proposal!.patch!.preconditions[0].forbiddenPatterns[0]);
    expect(pattern.test('this.hola = value;')).toBe(true);
    expect(pattern.test('other.hola = value;')).toBe(false);
  });

  it('refuses an unverifiable declaration', () => {
    const remediator = new DeterministicRemediator();
    const input = task('private hola = createValue();');

    expect(remediator.validatePreconditions(issue, input.context as never)).toEqual({
      valid: false,
      reason: 'No safe TypeScript field declaration was found for S2933.',
    });
    expect(remediator.propose(input, 'local', 0)).toMatchObject({
      success: false,
      error: { code: 'LOCAL_PRECONDITION_FAILED' },
    });
  });
});
