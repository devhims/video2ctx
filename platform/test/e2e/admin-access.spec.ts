import { expect, test } from '@playwright/test';

test('an admin can grant, search and remove Agent access on desktop and mobile', async ({ page, context }, testInfo) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  await page.goto('/dashboard/admin');
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
  await expect(page.getByText('first@example.test', { exact: true })).toBeVisible();
  await page.getByLabel('Email address', { exact: true }).fill('new-tester@example.test');
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(page.getByText('Agent access granted to new-tester@example.test.', { exact: true })).toBeVisible();
  await expect(page.getByText('new-tester@example.test', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search approved emails' }).fill('new-tester');
  await expect(page.getByText('first@example.test', { exact: true })).toHaveCount(0);
  await expect(page.getByText('new-tester@example.test', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-agent-access-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.getByRole('button', { name: 'Remove access for new-tester@example.test' }).click();
  await expect(page.getByText('Remove Agent access?', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-agent-access-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm removal for new-tester@example.test' }).click();
  await expect(page.getByText('Agent access removed for new-tester@example.test.', { exact: true })).toBeVisible();
  await expect(page.getByText('new-tester@example.test', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search approved emails' }).fill('new-tester');
  await expect(page.getByRole('heading', { name: 'No matching emails' })).toBeVisible();
});

test('a tester cannot see admin controls even by navigating directly', async ({ page, context }) => {
  await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' }]);
  await page.goto('/dashboard/admin');
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0);
});

test('revoking admin access hides controls and mutation errors remain visible', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  await page.goto('/dashboard/admin');
  await page.route('**/api/platform/v1/admin/agent-access', route => route.fulfill({ status: 503, json: { error: { message: 'Please try again.' } } }));
  await page.getByLabel('Email address', { exact: true }).fill('retry@example.test');
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Please try again.' })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('retry@example.test');
  await context.clearCookies({ name: 'admin-ui' });
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0);
});

test('admin diagnoses a run using complete nested payloads and downloads its timeline', async ({page,context},testInfo)=>{
  await context.addCookies([
    {name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},
    {name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'},
  ]);
  await page.goto('/dashboard/admin');
  await page.getByRole('button',{name:'Tool call traces',exact:true}).click();
  const runId='a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  await expect(page.getByRole('heading',{name:'Agent tool traces',exact:true})).toBeVisible();
  await page.getByLabel('Run, session or user ID').fill(runId);
  await page.getByRole('button',{name:'Search traces',exact:true}).click();
  await page.getByRole('button').filter({hasText:runId}).click();
  await page.getByRole('button').filter({hasText:'1. research_video_transcripts'}).click();
  await expect(page.getByRole('heading',{name:'Input',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Output',exact:true})).toBeVisible();
  await expect(page.locator('pre').first()).toContainText('Complete nested tool input');
  await expect(page.locator('pre').last()).toContainText('COMPLETE_OUTPUT_TAIL');
  await page.screenshot({path:testInfo.outputPath('admin-tool-trace-desktop.png'),fullPage:true});
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download timeline JSONL'}).click();
  const downloaded=await downloading;
  expect(downloaded.suggestedFilename()).toBe(`agent-trace-${runId}.jsonl`);
  await downloaded.saveAs(testInfo.outputPath('agent-trace.jsonl'));
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
  await page.screenshot({path:testInfo.outputPath('admin-tool-trace-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'All trace runs'}).click();
  await page.getByLabel('Run, session or user ID').fill('not-a-run');
  await page.getByRole('button',{name:'Search traces',exact:true}).click();
  await expect(page.getByText(/No traces found/)).toBeVisible();
});

test('refresh updates the run timeline and status while keeping a call selected',async({page,context})=>{
  await context.addCookies([
    {name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},
    {name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'},
  ]);
  const runId='a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  let completed=false;
  await page.route(`**/api/platform/v1/admin/agent-traces/${runId}`,async route=>{
    const response=await route.fetch();
    const run=await response.json();
    run.status=completed ? 'completed' : 'running';
    if (completed) run.calls.push({...run.calls[0],traceId:'52c8b6e4-3219-4580-99d7-aaa6c774f618',
      toolCallId:'later-call',name:'read_session_evidence',callSequence:3,resultSequence:4});
    await route.fulfill({response,json:run});
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button',{name:'Tool call traces',exact:true}).click();
  await page.getByRole('button').filter({hasText:runId}).click();
  await page.getByRole('button').filter({hasText:'1. research_video_transcripts'}).click();
  await expect(page.getByText(/User fixture-user · Session .* · running/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Output',exact:true})).toBeVisible();
  await expect(page.getByRole('button').filter({hasText:'3. read_session_evidence'})).toHaveCount(0);
  completed=true;
  await page.getByRole('button',{name:'Refresh traces',exact:true}).click();
  await expect(page.getByText(/User fixture-user · Session .* · completed/)).toBeVisible();
  await expect(page.getByRole('button').filter({hasText:'3. read_session_evidence'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Output',exact:true})).toBeVisible();
  await expect(page.locator('pre').last()).toContainText('COMPLETE_OUTPUT_TAIL');
});

test('export HTTP errors remain visible instead of downloading error JSON',async({page,context})=>{
  await context.addCookies([
    {name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},
    {name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'},
  ]);
  const runId='a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  const downloads:string[]=[];
  page.on('download',download=>downloads.push(download.suggestedFilename()));
  await page.goto('/dashboard/admin');
  await page.getByRole('button',{name:'Tool call traces',exact:true}).click();
  await page.getByRole('button').filter({hasText:runId}).click();
  await page.route(`**/api/platform/v1/admin/agent-traces/${runId}/export`,route=>route.fulfill({status:422,json:{error:{message:'This run is too large to export.'}}}));
  await page.getByRole('button',{name:'Download timeline JSONL'}).click();
  await expect(page.getByRole('alert').filter({hasText:'This run is too large to export.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Download timeline JSONL'})).toBeEnabled();
  expect(downloads).toEqual([]);
});
