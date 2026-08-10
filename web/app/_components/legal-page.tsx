import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from '../legal-page.module.css';

type LegalPageProps = {
  title: string;
  eyebrow: string;
  effectiveDate: string;
  summary: string;
  children: ReactNode;
};

export function LegalPage({ title, eyebrow, effectiveDate, summary, children }: LegalPageProps) {
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href='/' aria-label='Video2ctx home'>
          <img src='/brand/video2ctx-mark-red.svg' alt='' width='36' height='36' />
          <span>video2ctx</span>
        </Link>
        <nav aria-label='Legal pages'>
          <Link href='/privacy'>Privacy</Link>
          <Link href='/terms'>Terms</Link>
        </nav>
      </header>

      <article className={styles.article}>
        <header className={styles.intro}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.summary}>{summary}</p>
          <p className={styles.effective}>Effective {effectiveDate}</p>
        </header>
        <div className={styles.content}>{children}</div>
      </article>

      <footer className={styles.footer}>
        <p>Video2ctx · Evidence-first video research.</p>
        <div>
          <Link href='/'>Home</Link>
          <a href='mailto:privacy@video2ctx.dev'>privacy@video2ctx.dev</a>
        </div>
      </footer>
    </main>
  );
}
