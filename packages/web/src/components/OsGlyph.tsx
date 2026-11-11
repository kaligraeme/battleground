import { Box, Command, TerminalSquare } from 'lucide-react';
import type { OsFamily } from '@battleground/core';
import { cx } from './ui';

/**
 * Operating-system marker. These are deliberately generic glyphs (window
 * panes, a terminal prompt, a command key) rather than vendor logos.
 */
export function OsGlyph({ os, large, title }: { os: OsFamily | undefined; large?: boolean; title?: string }) {
  return (
    <span className={cx('os', os && `os--${os}`, large && 'os--lg')} title={title ?? osLabel(os)} aria-hidden={!title}>
      {os === 'windows' ? (
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <rect x="1.5" y="1.5" width="5.8" height="5.8" rx="0.8" />
          <rect x="8.7" y="1.5" width="5.8" height="5.8" rx="0.8" />
          <rect x="1.5" y="8.7" width="5.8" height="5.8" rx="0.8" />
          <rect x="8.7" y="8.7" width="5.8" height="5.8" rx="0.8" />
        </svg>
      ) : os === 'linux' ? (
        <TerminalSquare />
      ) : os === 'macos' ? (
        <Command />
      ) : (
        <Box />
      )}
    </span>
  );
}

export function osLabel(os: OsFamily | undefined): string {
  switch (os) {
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'macos':
      return 'macOS';
    default:
      return 'Unknown OS';
  }
}
