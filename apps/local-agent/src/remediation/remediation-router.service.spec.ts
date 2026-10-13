import type { AgentCodeContext, ProjectProfile, QualityIssue } from '@amp/core';
import { RemediationRouter } from './remediation-router.service';
import { IssueContextPolicy } from './issue-context-policy.service';

const profile = { runtime: 'node', framework: 'nest', hasDocker: false, hasSonar: true } as ProjectProfile;
const context: AgentCodeContext = { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'function run() {}' }] };
const issue = { id: '1', provider: 'sonar', rule: 'typescript:S3776', severity: 'CRITICAL', message: 'complex', file: 'src/a.ts' } as QualityIssue;

describe('RemediationRouter and IssueContextPolicy', () => {
  it('routes deterministic, reasoning and missing-context cases without an LLM decision', () => {
    const router = new RemediationRouter();
    expect(router.decide({ issue: { ...issue, rule: 'typescript:S1186' }, projectProfile: profile, context }).strategy).toBe('local');
    expect(router.decide({ issue: { ...issue, rule: 'typescript:S2933' }, projectProfile: profile, context }).strategy).toBe('local');
    expect(router.decide({ issue, projectProfile: profile, context }).strategy).toBe('llm');
    expect(router.decide({ issue, projectProfile: profile, context: { files: [], snippets: [] } }).strategy).toBe('manual');
  });

  it('keeps the target snippet complete and removes lower-priority context first', () => {
    process.env.AI_PROPOSE_MAX_INPUT_TOKENS = '300';
    try {
      const target = 'target'.repeat(40);
      const result = new IssueContextPolicy().reduce({
        files: ['src/a.ts', 'src/b.ts'], targetSymbol: 'C-Users-demo-src-A.run',
        snippets: [{ file: 'src/a.ts', content: target }, { file: 'src/b.ts', content: 'secondary'.repeat(100) }],
      });
      expect(result.context.snippets?.[0].content).toBe(target);
      expect(result.context.snippets).toHaveLength(1);
    } finally { delete process.env.AI_PROPOSE_MAX_INPUT_TOKENS; }
  });
});
