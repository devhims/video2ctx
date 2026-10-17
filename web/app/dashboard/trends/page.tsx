import { notFound } from 'next/navigation';
import { TRENDS_ENABLED } from '../../../lib/features';

// ResearchHost owns the visited panel so ongoing requests survive navigation.
export default function Page() {
  if (!TRENDS_ENABLED) notFound();
  return null;
}
