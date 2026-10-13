import type { AgentTask } from '@amp/core';
import { ApplyFixPromptBuilder } from './apply-fix-prompt.builder';

describe('ApplyFixPromptBuilder', () => {
  it('delegates code edits without asking OpenCode to duplicate platform validation', () => {
    const task = {
      proposalId: 'proposal-1',
      approvedProposal: { summary: 'fix it' },
      issue: { id: 'issue-1' },
      context: { snippets: [] },
      allowedFiles: ['src/a.ts'],
      constraints: [],
      validationCommands: { build: 'npm run build', unit: 'npm test' },
    } as unknown as AgentTask;
    const prompt = new ApplyFixPromptBuilder().build(task);
    expect(prompt).toContain('Do not run builds, tests, linters, scanners, type checks, or startup commands.');
    expect(prompt).not.toContain('npm run build');
    expect(prompt).not.toContain('npm test');
    expect(prompt).not.toContain('validationExpectations');
  });
});
