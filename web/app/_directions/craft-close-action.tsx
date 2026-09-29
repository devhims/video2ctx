'use client';

import { authClient } from '../../lib/auth-client';

/* Sign-in is OAuth-only, so /login is also sign-up. Someone already signed in
 * has nothing to create, so send them straight to their workspace instead. */
export function CraftCloseAction() {
  const { data: session } = authClient.useSession();

  return session?.user ? (
    <a className='craft-primary' href='/dashboard'>
      Open the workspace
    </a>
  ) : (
    <a className='craft-primary' href='/login'>
      Create a free account
    </a>
  );
}
