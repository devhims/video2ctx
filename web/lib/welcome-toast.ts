/* Better Auth redirects an account to `newUserCallbackURL` only on the sign-in
 * that created it, so this query parameter marks a user's first dashboard visit. */
const WELCOME_PARAM = 'welcome';
const BASE = 'https://video2ctx.local';

/** Use the recorded signup allowance, never the current spendable balance. */
export function welcomeMessage(name: string | null | undefined, signupCredits: number | null) {
  if (signupCredits === 5000) return {
    title: 'Your $10 launch gift is ready!',
    description: "We've added 5,000 free credits to your account.",
  };
  const firstName = name?.trim().split(/\s+/)[0];
  return {
    title: firstName ? `Welcome to video2ctx, ${firstName}! 🎉` : 'Welcome to video2ctx! 🎉',
    description: signupCredits && signupCredits > 0
      ? `${signupCredits.toLocaleString('en-US')} free credits are in your account. Can't wait to see what you build.`
      : "Can't wait to see what you build.",
  };
}

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
