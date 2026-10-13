import { Injectable } from '@nestjs/common';
import {
  collectSecretValues,
  redactSecretsInText,
  type AgentCodeContext,
  type AgentTask,
} from '@amp/core';

@Injectable()
export class ProposeFixPromptBuilder {
  build(task: AgentTask): string {
    if (task.type !== 'propose-fix' || !task.issue || !task.project) {
      throw new Error('Invalid propose-fix task');
    }
    const context = task.context as AgentCodeContext;
    const payload = {
      stack: [task.project.framework, task.project.runtime].filter(Boolean).join(' / '),
      rule: task.issue.rule,
      severity: task.issue.severity,
      issue: task.issue.message,
      file: task.issue.file,
      target: context.targetSymbol,
      relevantCode: (context.snippets ?? []).map((snippet) => ({
        file: snippet.file,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        code: snippet.content,
      })),
      relations: {
        callees: context.callees ?? [],
        callers: context.callers ?? [],
        tests: context.tests ?? [],
      },
      constraints: task.constraints,
    };
    const instructions = [
      'Analyze this Sonar issue and propose the smallest safe remediation.',
      'Do not modify files or request tool execution.',
      'Preserve behavior, avoid new dependencies, and reuse the existing project structure.',
      'Return only JSON with: summary, proposedChanges[{file,description}], risk (low|medium|high|unknown), confidence (0..1), warnings[].',
      'If the fix can be represented safely as an exact patch, also include patch:{version:1,edits:[{file,startLine,endLine,expectedText,replacement}],preconditions:[{file,forbiddenPatterns:[]}]}.',
      'If the issue requires complex multi-file refactoring, architectural changes, test generation, or iterative repair that cannot be expressed as a single structured patch, set requiresAgent:true and provide escalationReason explaining why.',
      'Use only relative files and exact text present in relevantCode; omit patch when the change is ambiguous.',
      'Do not include chain-of-thought, tutorials, or code that was not requested.',
    ].join('\n');
    return redactSecretsInText(
      `${instructions}\n\n${JSON.stringify(payload)}`,
      collectSecretValues(process.env),
    );
  }
}
