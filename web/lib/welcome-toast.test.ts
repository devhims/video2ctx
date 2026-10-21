import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isWelcomeVisit, newUserReturnPath, withoutWelcomeParam } from './welcome-toast.ts';

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
