import { Inject, Injectable } from '@nestjs/common';
import type {
  IndexContextQuery,
  IndexContextResult,
  IndexerProvider,
} from '@amp/providers';
import { loadConfig } from '../config/app-config';
import { INDEXER_PROVIDER } from '../providers/tokens';

/**
 * Applies context budget limits on top of IndexerProvider results.
 * Depends only on the IndexerProvider contract — never on Codebase Memory.
 */
@Injectable()
export class CodeContextService {
  constructor(
    @Inject(INDEXER_PROVIDER) private readonly indexer: IndexerProvider,
  ) {}

  async getContext(query: IndexContextQuery): Promise<IndexContextResult> {
    const raw = await this.indexer.getContext(query);
    return applyContextBudget(raw);
  }
}

export function applyContextBudget(
  result: IndexContextResult,
): IndexContextResult {
  const config = loadConfig().indexer;
  const symbols = result.symbols.slice(0, config.indexContextMaxSymbols);
  const relatedFiles = result.relatedFiles.slice(
    0,
    config.indexContextMaxFiles,
  );
  const snippets = result.snippets
    .slice(0, config.indexContextMaxSnippets)
    .map((s) => ({
      ...s,
      content:
        s.content.length > config.indexContextMaxSnippetChars
          ? `${s.content.slice(0, config.indexContextMaxSnippetChars)}\n…`
          : s.content,
    }));

  let target = result.target;
  if (target && symbols.length > 0) {
    const found = symbols.find((s) => sameSymbol(s, target));
    if (found) {
      target = found;
    }
  }

  return {
    ...result,
    target,
    symbols,
    relatedFiles,
    relations: result.relations.slice(0, 50),
    tests: result.tests.slice(0, config.indexContextMaxSymbols),
    snippets,
  };
}

function sameSymbol(
  a: { name: string; qualifiedName?: string; filePath?: string },
  b: { name: string; qualifiedName?: string; filePath?: string } | undefined,
): boolean {
  if (!b) {
    return false;
  }
  if (a.qualifiedName && b.qualifiedName) {
    return a.qualifiedName === b.qualifiedName;
  }
  return a.name === b.name && (a.filePath ?? '') === (b.filePath ?? '');
}
