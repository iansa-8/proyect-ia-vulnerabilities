export interface CodeBlockProps {
  children: string;
  className?: string;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  return (
    <pre className={['code-block', className].filter(Boolean).join(' ')}>
      <code>{children}</code>
    </pre>
  );
}
