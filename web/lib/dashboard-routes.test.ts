import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectItemPath } from '../app/dashboard/dashboard-routes.ts';

for (const entity_type of ['video', 'playlist', 'channel'] as const) {
  test(`legacy project ${entity_type} opens with an explicit legacy flag and no project auto-save context`, () => {
    const path = projectItemPath('project / one', { id: 'legacy', provider: 'youtube', entity_type, entity_id: 'entity / one' });
    const params = new URL(path, 'https://example.test').searchParams;
    assert.equal(params.has('project'), false);
    assert.equal(params.get('legacy'), '1');
    assert.equal(params.get('type'), entity_type);
    assert.equal(params.get('id'), 'entity / one');
    assert.equal(params.has('saved'), false);
  });
}

test('snapshot project source uses the project item ID rather than the Recent ID', () => {
  const params = new URL(projectItemPath('project / one', { id: 'project-item', source_id: 'recent-item', provider: 'youtube', entity_type: 'video', entity_id: 'video' }), 'https://example.test').searchParams;
  assert.equal(params.get('project'), 'project / one');
  assert.equal(params.get('saved'), 'project-item');
  assert.equal(params.has('id'), false);
});
