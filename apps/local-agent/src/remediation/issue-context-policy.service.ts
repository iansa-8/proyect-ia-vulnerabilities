import { Injectable, Logger } from '@nestjs/common';
import type { AgentCodeContext, BoundedProposalContext } from '@amp/core';
import { loadConfig } from '../config/app-config';

const CHARS_PER_TOKEN = 4;
const PROMPT_OVERHEAD_TOKENS = 260;

@Injectable()
export class IssueContextPolicy {
  private readonly logger = new Logger(IssueContextPolicy.name);
  
  reduce(context: AgentCodeContext): BoundedProposalContext {
    const maxTokens = loadConfig().llm.maxInputTokens;
    const maxChars = Math.max(0, (maxTokens - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN);
    this.logger.debug(`[IssueContextPolicy] Reducing context: maxTokens=${maxTokens} maxChars=${maxChars} snippets=${context.snippets?.length} files=${context.files?.length} symbols=${context.symbols?.length}`);
    
    const snippets = [...(context.snippets ?? [])];
    const primaryIndex = snippets.findIndex((item) =>
      context.files[0] ? normalize(item.file) === normalize(context.files[0]) : true,
    );
    if (primaryIndex > 0) snippets.unshift(snippets.splice(primaryIndex, 1)[0]);

    const kept: NonNullable<AgentCodeContext['snippets']> = [];
    let chars = 0;
    for (const [index, snippet] of snippets.entries()) {
      if (index === 0) {
        kept.push(snippet);
        chars += snippet.content.length;
        continue;
      }
      if (chars + snippet.content.length <= maxChars) {
        kept.push(snippet);
        chars += snippet.content.length;
      }
    }
    const warnings: string[] = [];
    if (snippets.length > kept.length) warnings.push('Contexto indirecto omitido por presupuesto de tokens.');
    if (chars > maxChars) warnings.push('La función objetivo supera por sí sola el presupuesto; se conservó completa.');
    
    this.logger.debug(`[IssueContextPolicy] Reduced: kept=${kept.length}/${snippets.length} snippets chars=${chars}/${maxChars} files=${context.files?.length}->${kept.map((item) => normalize(item.file)).filter(Boolean).length} warnings=${warnings.length}`);
    
    const reduced: AgentCodeContext = {
      ...context,
      targetSymbol: compactSymbol(context.targetSymbol),
      files: [...new Set(kept.map((item) => normalize(item.file)).filter(Boolean))],
      snippets: kept.map((item) => ({ ...item, file: normalize(item.file) })),
      symbols: (context.symbols ?? []).slice(0, 8).map(compactSymbol).filter(Boolean) as string[],
      callers: (context.callers ?? []).slice(0, 4).map(compactSymbol).filter(Boolean) as string[],
      callees: (context.callees ?? []).slice(0, 6).map(compactSymbol).filter(Boolean) as string[],
      tests: (context.tests ?? []).slice(0, 4).map(normalize),
      warnings: [...(context.warnings ?? []), ...warnings],
    };
    return {
      context: reduced,
      estimatedInputTokens: estimateTokens(JSON.stringify(reduced)) + PROMPT_OVERHEAD_TOKENS,
      warnings,
    };
  }
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function compactSymbol(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalize(value);
  const withoutDrive = normalized.replace(/^[A-Za-z]:\/.+?\/src\//, '');
  const marker = withoutDrive.match(/([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)$/);
  return marker?.[1] ?? withoutDrive.split('/').pop() ?? withoutDrive;
}
