import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isWelcomeVisit, newUserReturnPath, welcomeMessage, withoutWelcomeParam } from './welcome-toast.ts';

describe('welcome toast marker', () => {
  test('marks the return path for newly created accounts', () => {
    assert.equal(newUserReturnPath('/dashboard'), '/dashboard?welcome=1');
    assert.equal(newUserReturnPath('/dashboard/sessions?q=chess#latest'), '/dashboard/sessions?q=chess&welcome=1#latest');
  });

  test('recognises only the explicit marker', () => {
    assert.equal(isWelcomeVisit('?welcome=1'), true);
    assert.equal(isWelcomeVisit('?section=settings&welcome=1'), true);
    assert.equal(isWelcomeVisit('?welcome=0'), false);
    assert.equal(isWelcomeVisit(''), false);
  });

  test('removes the marker and keeps the rest of the location', () => {
    assert.equal(withoutWelcomeParam('/dashboard?welcome=1'), '/dashboard');
    assert.equal(withoutWelcomeParam('/dashboard/sessions?q=chess&welcome=1#latest'), '/dashboard/sessions?q=chess#latest');
  });
});


describe('welcome credit message', () => {
  test('uses the launch gift for a recorded 5,000-credit grant', () => {
    assert.deepEqual(welcomeMessage('Ari Lee', 5000), {
      title: 'Your $10 launch gift is ready!',
      description: "We've added 5,000 free credits to your account.",
    });
  });
  test('preserves the standard copy for older signups', () => {
    assert.equal(welcomeMessage('Ari Lee', 1000).title, 'Welcome to video2ctx, Ari! 🎉');
    assert.equal(welcomeMessage('Ari Lee', 1000).description, "1,000 free credits are in your account. Can't wait to see what you build.");
  });
  test('does not promise credits for a returning account or an unavailable allowance', () => {
    for (const credits of [0, null]) assert.equal(welcomeMessage(null, credits).description, "Can't wait to see what you build.");
  });
});
