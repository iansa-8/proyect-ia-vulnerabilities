import { applyContextBudget } from './code-context.service';
import type { IndexContextResult } from '@amp/providers';

describe('applyContextBudget', () => {
  const baseQuery = {
    projectId: 'p1',
    projectPath: 'C:\\tmp\\demo',
    symbol: 'Foo',
  };

  it('trims symbols, files and snippets', () => {
    process.env.INDEX_CONTEXT_MAX_SYMBOLS = '2';
    process.env.INDEX_CONTEXT_MAX_FILES = '1';
    process.env.INDEX_CONTEXT_MAX_SNIPPETS = '1';
    process.env.INDEX_CONTEXT_MAX_SNIPPET_CHARS = '10';

    const input: IndexContextResult = {
      query: baseQuery,
      symbols: [
        { name: 'A' },
        { name: 'B' },
        { name: 'C' },
      ],
      relatedFiles: ['a.ts', 'b.ts', 'c.ts'],
      relations: [],
      tests: [],
      snippets: [
        { content: '0123456789ABCDEF' },
        { content: 'second' },
      ],
    };

    const result = applyContextBudget(input);
    expect(result.symbols).toHaveLength(2);
    expect(result.relatedFiles).toHaveLength(1);
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0].content.endsWith('…')).toBe(true);
  });
});
