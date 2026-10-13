export interface DiffPreviewProps {
  removed: string;
  added: string;
}

function toLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function DiffPreview({ removed, added }: DiffPreviewProps) {
  const removedLines = toLines(removed);
  const addedLines = toLines(added);

  return (
    <pre className="diff-preview">
      <code>
        {removedLines.map((line, index) => (
          <span key={`r-${index}`} className="diff-preview__line diff-preview__line--removed">
            <span className="diff-preview__sign">−</span>
            {line}
            {'\n'}
          </span>
        ))}
        {addedLines.map((line, index) => (
          <span key={`a-${index}`} className="diff-preview__line diff-preview__line--added">
            <span className="diff-preview__sign">+</span>
            {line}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}
