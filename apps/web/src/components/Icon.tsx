import type { ReactNode } from 'react';

export type IconName =
  | 'download'
  | 'report'
  | 'refresh'
  | 'code'
  | 'lightbulb'
  | 'sparkles'
  | 'robot'
  | 'reject'
  | 'play'
  | 'check'
  | 'close'
  | 'spinner'
  | 'minus'
  | 'undo'
  | 'clock'
  | 'dot'
  | 'chevron';

const PATHS: Record<IconName, ReactNode> = {
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  report: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  code: (
    <>
      <path d="m9 8-5 4 5 4" />
      <path d="m15 8 5 4-5 4" />
    </>
  ),
  lightbulb: (
    <>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .9 1.6l.1.6h5.2l.1-.6c.1-.6.4-1.2.9-1.6A6 6 0 0 0 12 3z" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 4.5 13.6 9 18 10.6 13.6 12.2 12 16.7 10.4 12.2 6 10.6 10.4 9z" />
      <path d="M18.5 4.5 19.2 6.3 21 7l-1.8.7-.7 1.8-.7-1.8L16 7l1.8-.7z" />
    </>
  ),
  robot: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 8V5" />
      <circle cx="9" cy="13.5" r="1" />
      <circle cx="15" cy="13.5" r="1" />
    </>
  ),
  reject: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </>
  ),
  play: (
    <>
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M12 3a9 9 0 0 1 9 9" />
      <path d="m10.5 9 5 3-5 3z" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  spinner: (
    <>
      <path d="M12 3a9 9 0 0 1 9 9" />
      <path d="M21 12a9 9 0 0 1-9 9" opacity="0.45" />
      <path d="M12 21a9 9 0 0 1-9-9" opacity="0.25" />
    </>
  ),
  minus: <path d="M6 12h12" />,
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
};

export interface IconProps {
  name: IconName;
  className?: string;
  size?: number;
}

export function Icon({ name, className, size = 16 }: IconProps) {
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
