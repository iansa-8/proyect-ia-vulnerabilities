export interface ErrorStateProps {
  message: string;
  details?: string | null;
  className?: string;
}

function looksTechnical(text: string): boolean {
  return (
    text.length > 160 ||
    text.includes('\n') ||
    /stderr|stack|at\s+\S+\(|Error:|ENOENT|EACCES/i.test(text)
  );
}

export function ErrorState({ message, details, className }: ErrorStateProps) {
  const shortMessage =
    looksTechnical(message) && !details
      ? message.split('\n')[0]?.slice(0, 160) || message
      : message;
  const technical =
    details ?? (looksTechnical(message) && shortMessage !== message ? message : null);

  return (
    <div
      className={['error-state', className].filter(Boolean).join(' ')}
      role="alert"
    >
      <p className="error-state__message">{shortMessage}</p>
      {technical ? (
        <details className="error-state__details">
          <summary>Detalles técnicos</summary>
          <pre className="error-state__pre">{technical}</pre>
        </details>
      ) : null}
    </div>
  );
}
