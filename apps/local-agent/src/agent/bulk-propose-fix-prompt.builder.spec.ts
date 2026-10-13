import { BulkProposeFixPromptBuilder } from './bulk-propose-fix-prompt.builder';

describe('BulkProposeFixPromptBuilder', () => {
  it('deduplicates shared code and keeps exact issue-to-context references', () => {
    const prompt = new BulkProposeFixPromptBuilder().build({
      project: { runtime: 'node', framework: 'nest' },
      constraints: ['preserve behavior'],
      items: [
        {
          issue: { id: 'issue-1', provider: 'sonar', rule: 'typescript:S1186', severity: 'MAJOR', message: 'First', file: 'src/a.ts', line: 4 },
          context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', startLine: 1, endLine: 6, content: 'class SharedContextExample {}' }] },
        },
        {
          issue: { id: 'issue-2', provider: 'sonar', rule: 'typescript:S1186', severity: 'MAJOR', message: 'Second', file: 'src/a.ts', line: 5 },
          context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', startLine: 1, endLine: 6, content: 'class SharedContextExample {}' }] },
        },
      ],
    });

    expect(prompt.match(/class SharedContextExample \{\}/g)).toHaveLength(1);
    expect(prompt).toContain('"id":"issue-1"');
    expect(prompt).toContain('"id":"issue-2"');
    expect(prompt.match(/"ctx-1"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(prompt).toContain('exactly one entry per supplied issueId');
  });

  it('redacts configured secrets from the exact auditable prompt', () => {
    process.env.SONAR_TOKEN = 'bulk-secret-token';
    try {
      const prompt = new BulkProposeFixPromptBuilder().build({
        project: {}, constraints: [], items: [{
          issue: { id: 'issue-1', provider: 'sonar', message: 'bulk-secret-token', file: 'src/a.ts' },
          context: { files: ['src/a.ts'], snippets: [] },
        }],
      });
      expect(prompt).not.toContain('bulk-secret-token');
      expect(prompt).toContain('[REDACTED]');
    } finally {
      delete process.env.SONAR_TOKEN;
    }
  });

  it('uses the shorter agent-only contract for cognitive-complexity issues', () => {
    const prompt = new BulkProposeFixPromptBuilder().build({
      project: { runtime: 'node' }, constraints: [], items: [{
        issue: { id: 'complex-1', provider: 'sonar', rule: 'typescript:S3776', type: 'CODE_SMELL', message: 'Reduce complexity', file: 'src/a.ts' },
        context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'function complex() {}' }] },
      }],
    });
    expect(prompt).toContain('omit patch and set requiresAgent:true');
    expect(prompt).not.toContain('"expectedText"');
  });
});
