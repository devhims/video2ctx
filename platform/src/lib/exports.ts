import { ApiError, now } from './http';

type Format = 'txt' | 'md' | 'json' | 'csv' | 'srt' | 'vtt';

interface ItemRow {
  title: string;
  entity_type: string;
  entity_id: string;
  start_ms: number | null;
  end_ms: number | null;
  note: string;
  tags_json: string;
}

export async function createProjectExport(env: Env, userId: string, projectId: string, format: Format) {
  const project = await env.DB.prepare('SELECT name,description FROM projects WHERE id=? AND user_id=?')
    .bind(projectId, userId).first<{ name: string; description: string }>();
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  const rows = await env.DB.prepare(
    `SELECT title,entity_type,entity_id,start_ms,end_ms,note,tags_json
     FROM project_items WHERE project_id=? AND user_id=? ORDER BY created_at`
  ).bind(projectId, userId).all<ItemRow>();
  const content = serialize(format, project, rows.results);
  const id = crypto.randomUUID();
  const key = `private/${userId}/exports/${id}.${format}`;
  await env.RESEARCH.put(key, content, { httpMetadata: { contentType: contentType(format) } });
  await env.DB.prepare(
    'INSERT INTO exports (id,user_id,project_id,format,r2_key,created_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, userId, projectId, format, key, now()).run();
  return { id, format, key, contentType: contentType(format) };
}

export function assertFormat(value: string): Format {
  if (!['txt', 'md', 'json', 'csv', 'srt', 'vtt'].includes(value)) {
    throw new ApiError(422, 'UNSUPPORTED_EXPORT_FORMAT', 'Use TXT, Markdown, JSON, CSV, SRT, or VTT.');
  }
  return value as Format;
}

function serialize(format: Format, project: { name: string; description: string }, items: ItemRow[]): string {
  if (format === 'json') return JSON.stringify({ project, items: items.map(item => ({ ...item, tags: JSON.parse(item.tags_json) })) }, null, 2);
  if (format === 'csv') {
    const lines = [['title','type','entity_id','start_ms','end_ms','note','tags'].join(',')];
    for (const item of items) lines.push([item.title,item.entity_type,item.entity_id,item.start_ms,item.end_ms,item.note,item.tags_json].map(csv).join(','));
    return lines.join('\n');
  }
  if (format === 'srt' || format === 'vtt') {
    const cues = items.filter((item) => item.start_ms !== null);
    const body = cues.map((item, index) => {
      const start = timestamp(item.start_ms ?? 0, format);
      const end = timestamp(item.end_ms ?? (item.start_ms ?? 0) + 5000, format);
      return `${format === 'srt' ? `${index + 1}\n` : ''}${start} --> ${end}\n${item.note || item.title}`;
    }).join('\n\n');
    return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
  }
  const lines = [`# ${project.name}`, project.description, ''];
  for (const item of items) {
    const url = item.entity_type === 'video'
      ? `https://youtube.com/watch?v=${item.entity_id}${item.start_ms ? `&t=${Math.floor(item.start_ms / 1000)}s` : ''}`
      : item.entity_id;
    lines.push(format === 'md' ? `- [${item.title}](${url}) — ${item.note}` : `- ${item.title} (${url}) — ${item.note}`);
  }
  return lines.join('\n');
}

function csv(value: unknown): string { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function timestamp(milliseconds: number, format: Format): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}${format === 'srt' ? ',' : '.'}${String(millis).padStart(3,'0')}`;
}
function contentType(format: Format): string {
  return ({ txt:'text/plain', md:'text/markdown', json:'application/json', csv:'text/csv', srt:'application/x-subrip', vtt:'text/vtt' } as const)[format] + '; charset=utf-8';
}
