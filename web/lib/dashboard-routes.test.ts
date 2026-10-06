import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectItemPath } from '../app/dashboard/dashboard-routes.ts';

const linkFor = (item: Parameters<typeof projectItemPath>[1]) => new URL(projectItemPath('project / one', item), 'https://example.test').searchParams;

for (const entity_type of ['video', 'playlist', 'channel'] as const) {
  test(`an older ${entity_type} item opens its saved item from storage without an Add sources context`, () => {
    const params = linkFor({ id: 'legacy-item', provider: 'youtube', entity_type, entity_id: 'entity / one' });
    assert.equal(params.get('openProject'), 'project / one');
    assert.equal(params.get('saved'), 'legacy-item');
    // project= would also turn on automatic saving into the project.
    assert.equal(params.has('project'), false);
    assert.equal(params.has('id'), false);
    assert.equal(params.has('type'), false);
  });
}

test('a project source and a saved moment use their own project item IDs rather than a Recent ID', () => {
  const source = linkFor({ id: 'project-item', source_id: 'recent-item', provider: 'youtube', entity_type: 'video', entity_id: 'video' });
  assert.equal(source.get('saved'), 'project-item');
  const moment = linkFor({ id: 'moment-item', provider: 'youtube', entity_type: 'video', entity_id: 'video', start_ms: 0 });
  assert.equal(moment.get('saved'), 'moment-item');
  assert.equal(moment.has('project'), false);
});
