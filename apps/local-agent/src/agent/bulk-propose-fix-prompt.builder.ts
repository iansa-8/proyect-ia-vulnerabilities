import { Injectable } from '@nestjs/common';
import { collectSecretValues, redactSecretsInText, type AgentCodeContext, type AgentIssueContext } from '@amp/core';

export interface BulkPromptIssue {
  issue: AgentIssueContext;
  context: AgentCodeContext;
}

export interface BulkPromptInput {
  project: { runtime?: string; framework?: string };
  items: BulkPromptIssue[];
  constraints: string[];
}

@Injectable()
export class BulkProposeFixPromptBuilder {
  build(input: BulkPromptInput): string {
    const snippets = new Map<string, { id: string; file: string; startLine?: number; endLine?: number; code: string }>();
    const issues = input.items.map(({ issue, context }) => {
      const contextRefs: string[] = [];
      for (const snippet of context.snippets ?? []) {
        const key = `${snippet.file}:${snippet.startLine ?? ''}:${snippet.endLine ?? ''}:${snippet.content}`;
        let shared = snippets.get(key);
        if (!shared) {
          shared = { id: `ctx-${snippets.size + 1}`, file: snippet.file, startLine: snippet.startLine, endLine: snippet.endLine, code: snippet.content };
          snippets.set(key, shared);
        }
        contextRefs.push(shared.id);
      }
      const relations = {
        callers: compactList(context.callers, 8),
        callees: compactList(context.callees, 8),
        tests: compactList(context.tests, 6),
      };
      const warnings = (context.warnings ?? []).slice(0, 4);
      const hasRelations = Object.values(relations).some((values) => values.length > 0);
      return {
        id: issue.id,
        rule: issue.rule,
        severity: issue.severity,
        type: issue.type,
        message: issue.message,
        file: issue.file,
        line: issue.line,
        target: context.targetSymbol,
        contextRefs,
        ...(hasRelations ? { relations } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    });
    const payload = {
      stack: [...new Set([input.project.framework, input.project.runtime].filter(Boolean))].join(' / '),
      issues,
      sharedContext: [...snippets.values()],
      constraints: input.constraints,
    };
    const agentOnly = issues.some((issue) => issue.rule === 'typescript:S3776' || issue.type === 'VULNERABILITY');
    const proposalShape = agentOnly
      ? '{"proposals":[{"issueId":"id","summary":"...","proposedChanges":[{"file":"path","description":"...","rationale":"..."}],"risk":"low|medium|high|unknown","warnings":[],"requiresAgent":true,"escalationReason":"..."}]}'
      : '{"proposals":[{"issueId":"id","summary":"...","proposedChanges":[{"file":"path","description":"..."}],"risk":"low|medium|high|unknown","warnings":[],"patch":{"version":1,"edits":[{"file":"path","startLine":1,"endLine":1,"expectedText":"exact","replacement":"new"}],"preconditions":[]},"requiresAgent":false}]}';
    const instructions = [
      'Propose the smallest behavior-preserving fix for every supplied Sonar issue. Do not modify files or use tools.',
      `Return JSON only, exactly one entry per supplied issueId: ${proposalShape}`,
      'sharedContext is deduplicated; contextRefs identify the code for each issue. Use relative paths and only supplied facts.',
      'Keep summaries <=160 chars, descriptions/rationales <=220 chars, and at most 2 short warnings. No markdown or chain-of-thought.',
      agentOnly
        ? 'This batch requires code refactoring: omit patch and set requiresAgent:true with a concise escalationReason.'
        : 'Include patch only for one exact safe edit <=500 chars; otherwise omit it and set requiresAgent:true.',
      'Use the exact JSON field names. Do not emit trailing commas or literal newlines inside strings.',
    ].join('\n');
    return redactSecretsInText(`${instructions}\n\n${JSON.stringify(payload)}`, collectSecretValues(process.env));
  }
}

function compactList(values: string[] | undefined, max: number): string[] {
  return [...new Set(values ?? [])].slice(0, max);
}
