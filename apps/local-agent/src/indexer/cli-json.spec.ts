import {
  extractJsonPayload,
  CliOutputParseError,
} from './cli-json';

describe('cli-json', () => {
  it('unwraps structuredContent from MCP envelope', () => {
    const stdout = JSON.stringify({
      content: [{ type: 'text', text: 'ignore' }],
      structuredContent: { projects: [], total: 0 },
      isError: false,
    });
    const payload = extractJsonPayload(stdout) as { total: number };
    expect(payload.total).toBe(0);
  });

  it('parses nested JSON text when structuredContent is absent', () => {
    const stdout = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ nodes: [{ name: 'Foo' }] }),
        },
      ],
      isError: false,
    });
    const payload = extractJsonPayload(stdout) as {
      nodes: Array<{ name: string }>;
    };
    expect(payload.nodes[0].name).toBe('Foo');
  });

  it('throws on isError true', () => {
    const stdout = JSON.stringify({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
    expect(() => extractJsonPayload(stdout)).toThrow(CliOutputParseError);
  });

  it('throws on empty stdout', () => {
    expect(() => extractJsonPayload('')).toThrow(CliOutputParseError);
  });
});
