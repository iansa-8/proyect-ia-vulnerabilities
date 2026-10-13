import { useMemo, type ReactNode } from 'react';

function unescapeText(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

function tryParse(candidate: string): unknown | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function splitPrompt(raw: string): { text: string; json: unknown | null } {
  if (!raw) return { text: '', json: null };

  const markers = ['\nINPUT:\n', '\n\n'];
  for (const marker of markers) {
    const idx = raw.lastIndexOf(marker);
    if (idx === -1) continue;
    const parsed = tryParse(raw.slice(idx + marker.length));
    if (parsed) {
      return { text: raw.slice(0, idx).trim(), json: parsed };
    }
  }

  let count = 0;
  for (let i = raw.indexOf('{'); i !== -1 && count < 400; i = raw.indexOf('{', i + 1), count += 1) {
    const parsed = tryParse(raw.slice(i));
    if (parsed) {
      return { text: raw.slice(0, i).trim(), json: parsed };
    }
  }

  return { text: raw, json: null };
}

function StringValue({ value }: { value: string }) {
  const text = unescapeText(value);
  if (!text.trim()) return <span className="prompt-json__empty-value">—</span>;
  if (text.includes('\n')) {
    return (
      <pre className="prompt-json__code">
        <code>{text}</code>
      </pre>
    );
  }
  return <span className="prompt-json__string">{text}</span>;
}

function JsonValue({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span className="prompt-json__null">null</span>;
  if (typeof value === 'boolean') {
    return <span className="prompt-json__boolean">{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="prompt-json__number">{String(value)}</span>;
  }
  if (typeof value === 'string') return <StringValue value={value} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="prompt-json__empty-value">[]</span>;
    return (
      <ol className="prompt-json__list">
        {value.map((item, index) => (
          <li key={index} className="prompt-json__list-item">
            <JsonValue value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="prompt-json__empty-value">{'{}'}</span>;
    return (
      <dl className="prompt-json__object">
        {entries.map(([key, entryValue]) => (
          <div key={key} className="prompt-json__field">
            <dt className="prompt-json__key">{key}</dt>
            <dd className="prompt-json__value">
              <JsonValue value={entryValue} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

export interface PromptViewerProps {
  prompt: string;
  truncated?: boolean;
}

export function PromptViewer({ prompt, truncated }: PromptViewerProps) {
  const { text, json } = useMemo(() => splitPrompt(prompt), [prompt]);

  if (!text && json === null) return null;

  return (
    <div className="prompt-viewer">
      {text ? (
        <div className="prompt-viewer__text">
          {unescapeText(text).split('\n').map((line, index) =>
            line.trim() === '' ? null : <p key={index}>{line}</p>,
          )}
        </div>
      ) : null}
      {json !== null ? (
        <div className="prompt-viewer__json">
          <JsonValue value={json} />
        </div>
      ) : null}
      {truncated ? (
        <p className="prompt-viewer__hint">Vista truncada por el límite de auditoría configurado.</p>
      ) : null}
    </div>
  );
}
