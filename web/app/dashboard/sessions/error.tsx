'use client';
import Link from 'next/link';

export default function SessionsError({ retry }: { retry: () => void }) {
  return <main className='agent-sessions-error'>
    <h1>Sessions are temporarily unavailable</h1>
    <p>We could not verify access or load your sessions. Please try again.</p>
    <button onClick={retry}>Try again</button> <Link href='/dashboard'>Back to dashboard</Link>
  </main>;
}
