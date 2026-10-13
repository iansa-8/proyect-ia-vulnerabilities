/**
 * Parses Codebase Memory CLI JSON envelopes.
 * Prefer structuredContent; fall back to content[0].text JSON.
 */

export class CliOutputParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliOutputParseError';
  }
}

export interface CliEnvelope {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

export function extractJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new CliOutputParseError('CLI stdout vacío');
  }

  // Prefer last JSON object (CLI may emit log lines before JSON).
  const candidates = findJsonCandidates(trimmed);
  let lastError: unknown;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]) as CliEnvelope | unknown;
      return unwrapEnvelope(parsed);
    } catch (err) {
      lastError = err;
    }
  }
  throw new CliOutputParseError(
    `Salida CLI no es JSON válido: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function findJsonCandidates(text: string): string[] {
  const results: string[] = [];
  // Whole text
  results.push(text);
  // Lines that look like JSON objects
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      results.push(t);
    }
  }
  // First { ... last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    results.push(text.slice(start, end + 1));
  }
  return results;
}

function unwrapEnvelope(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  const envelope = parsed as CliEnvelope;
  if (envelope.isError === true) {
    const msg = extractErrorText(envelope) ?? 'CLI reportó isError=true';
    throw new CliOutputParseError(msg);
  }
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent;
  }
  if (Array.isArray(envelope.content) && envelope.content.length > 0) {
    const text = envelope.content
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join('\n')
      .trim();
    if (!text) {
      return envelope;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Non-JSON text payload (tree format) — return as { text }
      return { text };
    }
  }
  return parsed;
}

function extractErrorText(envelope: CliEnvelope): string | undefined {
  if (!Array.isArray(envelope.content)) {
    return undefined;
  }
  const text = envelope.content
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
  return text || undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
