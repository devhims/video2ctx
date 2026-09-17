import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchServerSession } from '../../lib/server-session';
import { dashboardReturnTo } from '../../lib/login-redirect';
import LoginForm from './LoginForm';
import styles from './login.module.css';

export const metadata: Metadata = {
  title: 'Sign in | video2ctx',
  description: 'Sign in to your video2ctx research workspace.',
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const params = await searchParams;
  const returnTo = dashboardReturnTo(params.returnTo);
  if (await fetchServerSession(await headers())) redirect(returnTo);

  return <main className={`craft ${styles.page}`}>
    <section className={styles.story} aria-labelledby='login-intro'>
      <Link className={styles.brand} href='/' aria-label='video2ctx home'>
        <img src='/brand/logo-120.png' width='36' height='36' alt='' />
        <span>video2ctx</span>
      </Link>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>Your research workspace</p>
        <h1 id='login-intro'>Less watching.<br /><span>More understanding.</span></h1>
        <p>Ask about any YouTube video. Follow the sources.<br className={styles.desktopBreak} /> Keep the ideas worth coming back to.</p>
        <div className={styles.sourceNote} aria-hidden='true'>
          <div className={styles.sourceHeading}><span className={styles.play}>▶</span><span>From video to context</span><span className={styles.timestamp}>00:00</span></div>
          <div className={styles.transcript}><i /><i /><i /></div>
          <div className={styles.sourceFooter}><span>Transcript</span><span>Sources</span><span>Your next question</span></div>
        </div>
      </div>
      <p className={styles.storyFooter}>A place for your sources, questions, and discoveries.</p>
    </section>
    <section className={styles.access} aria-labelledby='login-title'>
      <Link className={styles.back} href='/'>← Back to home</Link>
      <div className={styles.formWrap}>
        <h2 id='login-title'>Welcome to video2ctx</h2>
        <p className={styles.subtitle}>Sign in or create an account to get started.</p>
        <LoginForm returnTo={returnTo} hasError={Boolean(params.error)} />
        <p className={styles.legal}>By continuing, you agree to our <Link href='/terms'>Terms of service</Link> and <Link href='/privacy'>Privacy policy</Link>.</p>
      </div>
      <a className={styles.help} href='https://docs.video2ctx.dev'>Explore the documentation ↗</a>
    </section>
  </main>;
}
