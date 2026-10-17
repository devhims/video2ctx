import type { Page } from '@playwright/test';

// Server-rendered dashboard HTML is visible, and clickable, before React attaches its handlers.
// Wait until React owns the shell before interacting. A string expression keeps DOM globals out
// of the platform type check.
export async function waitForHydration(page: Page, selector = '.workspace-shell') {
  await page.waitForFunction(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .some(element => Object.keys(element).some(key => key.startsWith('__reactFiber')))`);
}
