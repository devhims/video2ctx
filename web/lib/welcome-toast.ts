/* Better Auth redirects an account to `newUserCallbackURL` only on the sign-in
 * that created it, so this query parameter marks a user's first dashboard visit. */
const WELCOME_PARAM = 'welcome';
const BASE = 'https://video2ctx.local';

/** The dashboard path a newly created account lands on after signup. */
export function newUserReturnPath(returnTo: string): string {
  const url = new URL(returnTo, BASE);
  url.searchParams.set(WELCOME_PARAM, '1');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isWelcomeVisit(search: string): boolean {
  return new URLSearchParams(search).get(WELCOME_PARAM) === '1';
}

/** The current path without the welcome marker, so a refresh does not repeat the toast. */
export function withoutWelcomeParam(path: string): string {
  const url = new URL(path, BASE);
  url.searchParams.delete(WELCOME_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
