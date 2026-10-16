import type { CSSProperties, ReactNode } from 'react';

/* react-email's Section and Container move padding onto an inner cell but keep
 * the class on the outer table, so a class-based mobile override never reaches
 * the padding. This cell carries both. */
export function PaddedCell({ className, style, children }: { className: string; style: CSSProperties; children: ReactNode }) {
  return <table role='presentation' width='100%' cellPadding='0' cellSpacing='0' border={0}>
    <tbody><tr><td className={className} style={style}>{children}</td></tr></tbody>
  </table>;
}
