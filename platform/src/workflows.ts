import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { ImportPayload, MonitorPayload } from './types';
import { indexPrivateDocument, indexPublicDocument } from './lib/search';
import { getAllComments, getChannel, getChannelVideos, getComments, getPlaylist, getTranscript, getVideo, searchYouTube } from './lib/youtube';
import { now } from './lib/http';

export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportPayload> {
  async run(event: WorkflowEvent<ImportPayload>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    await step.do('mark-running', async () => {
      await this.env.DB.prepare(
        `UPDATE jobs SET status='running', progress=5, attempts=attempts+1, updated_at=? WHERE id=? AND user_id=?`
      ).bind(now(), input.jobId, input.userId).run();
    });

    try {
      const result = await step.do(
        'fetch-and-store',
        { retries: { limit: 4, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
        async () => this.importEntity(input)
      );
      await step.do('mark-complete', async () => {
        await this.env.DB.prepare(
          `UPDATE jobs SET status=?, progress=100, partial_result_json=?, updated_at=? WHERE id=? AND user_id=?`
        ).bind(result.partial ? 'partial' : 'succeeded', JSON.stringify(result), now(), input.jobId, input.userId).run();
      });
    } catch (error) {
      await step.do('record-permanent-failure', async () => {
        await this.env.DB.prepare(
          `UPDATE jobs SET status='failed', failure_code='IMPORT_FAILED', failure_reason=?, updated_at=? WHERE id=? AND user_id=?`
        ).bind(error instanceof Error ? error.message.slice(0, 500) : 'Unknown import failure', now(), input.jobId, input.userId).run();
      });
      throw error;
    }
  }

  private async importEntity(input: ImportPayload): Promise<ImportResult> {
    if (input.kind === 'video') {
      const [video, transcript] = await Promise.all([
        getVideo(this.env, input.entityId),
        getTranscript(this.env, input.entityId),
      ]);
      const content = transcript.segments
        .map((segment) => `[${segment.startMs}] ${segment.text}`)
        .join('\n');
      const r2Key = `public/videos/${input.entityId}/transcript-${transcript.track.languageCode}.json`;
      await this.env.RESEARCH.put(r2Key, JSON.stringify(transcript), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { entity_id: input.entityId, language: transcript.track.languageCode },
      });
      await indexPublicDocument(this.env, {
        entityId: input.entityId,
        title: video.title,
        content,
        language: transcript.track.languageCode,
      });
      if (input.projectId) {
        await indexPrivateDocument(this.env, {
          userId: input.userId,
          projectId: input.projectId,
          entityId: input.entityId,
          title: video.title,
          content,
        });
      }
      return { entityType: 'video', entityId: input.entityId, title: video.title, segments: transcript.segments.length, partial: false };
    }

    if (input.kind === 'channel') {
      const channel = await getChannel(this.env, input.entityId);
      const catalog = await getChannelVideos(this.env, channel.id);
      const eager = catalog.videos.slice(0, 25);
      for (const video of eager) {
        await this.env.TASKS.send({
          type: 'snapshot-statistics',
          idempotencyKey: `snapshot:${video.id}:${new Date().toISOString().slice(0, 13)}`,
          payload: { entityId: video.id, viewCount: video.viewCount },
        }, { contentType: 'json' });
      }
      await this.enqueueVideoImports(input, eager.slice(0, 10).map((video) => video.id));
      return {
        entityType: 'channel', entityId: input.entityId, title: channel.name,
        discovered: catalog.videos.length, eager: eager.length,
        partial: Boolean(catalog.continuation), continuation: catalog.continuation,
      };
    }

    if (input.kind === 'playlist') {
      const playlist = await getPlaylist(this.env, input.entityId);
      await this.enqueueVideoImports(input, playlist.videos.slice(0, 10).map((video) => video.id));
      return {
        entityType: 'playlist', entityId: input.entityId, title: playlist.title,
        discovered: playlist.videos.length, partial: Boolean(playlist.continuation),
        continuation: playlist.continuation,
      };
    }

    const pages = [];
    let continuation: string | undefined;
    let partial = false;
    if (input.kind === 'deep-comments') {
      const comments = await getAllComments(this.env, input.entityId);
      pages.push(...comments.comments);
      partial = !comments.complete;
      continuation = comments.continuation;
    } else {
      for (let page = 0; page < 2; page += 1) {
        const comments = await getComments(this.env, input.entityId, continuation);
        pages.push(...comments.comments);
        continuation = comments.continuation;
        if (!continuation) break;
      }
      partial = Boolean(continuation);
    }
    await this.env.RESEARCH.put(
      `public/videos/${input.entityId}/comments.json`,
      JSON.stringify({ comments: pages, continuation, complete: !partial, fetchedAt: new Date().toISOString() }),
      { httpMetadata: { contentType: 'application/json' }, customMetadata: { entity_id: input.entityId } }
    );
    return {
      entityType: 'comments', entityId: input.entityId,
      discovered: pages.length, partial, continuation,
    };
  }

  private async enqueueVideoImports(parent: ImportPayload, videoIds: string[]): Promise<void> {
    for (const entityId of videoIds) {
      const idempotencyKey = `eager:${parent.kind}:${parent.entityId}:${entityId}`;
      const existing = await this.env.DB.prepare('SELECT id FROM jobs WHERE user_id=? AND idempotency_key=?')
        .bind(parent.userId, idempotencyKey).first<{ id: string }>();
      if (existing) continue;
      const jobId = crypto.randomUUID();
      const child: ImportPayload = {
        jobId, userId: parent.userId, kind: 'video', entityId,
        projectId: parent.projectId, idempotencyKey,
      };
      await this.env.DB.prepare(
        `INSERT INTO jobs (id,user_id,kind,input_json,status,idempotency_key,created_at,updated_at)
         VALUES (?,?, 'video',?,'queued',?,?,?)`
      ).bind(jobId, parent.userId, JSON.stringify(child), idempotencyKey, now(), now()).run();
      await this.env.IMPORT_WORKFLOW.create({ id: `import-${jobId}`, params: child });
    }
  }
}

export class MonitorWorkflow extends WorkflowEntrypoint<Env, MonitorPayload> {
  async run(event: WorkflowEvent<MonitorPayload>, step: WorkflowStep): Promise<void> {
    const payload = event.payload;
    const monitors = await step.do('load-monitors', async (): Promise<MonitorRow[]> => {
      if (payload.monitorId && payload.userId) {
        const monitor = await this.env.DB.prepare(
          'SELECT * FROM monitors WHERE id=? AND user_id=? AND enabled=1'
        ).bind(payload.monitorId, payload.userId).first<MonitorRow>();
        return monitor ? [monitor] : [];
      }
      const result = await this.env.DB.prepare('SELECT * FROM monitors WHERE enabled=1').all<MonitorRow>();
      return result.results;
    });

    for (const monitor of monitors) {
      await step.do(`check-${String(monitor.id)}`, async () => {
        const target = String(monitor.target);
        const result = await searchYouTube(this.env, target, { type: 'video', sort: 'date' });
        const newest = result.results[0];
        const previous = typeof monitor.last_cursor === 'string' ? monitor.last_cursor : undefined;
        if (newest?.type === 'video' && newest.id !== previous) {
          await this.env.DB.prepare(
            `INSERT INTO notifications (id,user_id,type,title,body,data_json,created_at)
             VALUES (?,?,'monitor_match',?,?,?,?)`
          ).bind(
            crypto.randomUUID(), String(monitor.user_id), 'New monitored video', newest.title,
            JSON.stringify({ monitorId: monitor.id, videoId: newest.id, target }), now()
          ).run();
          await this.env.DB.prepare('UPDATE monitors SET last_cursor=?, last_checked_at=? WHERE id=?')
            .bind(newest.id, now(), monitor.id).run();
        } else {
          await this.env.DB.prepare('UPDATE monitors SET last_checked_at=? WHERE id=?').bind(now(), monitor.id).run();
        }
      });
    }
  }
}

interface ImportResult {
  entityType: string;
  entityId: string;
  title?: string;
  segments?: number;
  discovered?: number;
  eager?: number;
  partial: boolean;
  continuation?: string;
}

interface MonitorRow {
  id: string;
  user_id: string;
  kind: string;
  target: string;
  query_json: string;
  cadence: string;
  enabled: number;
  last_checked_at: number | null;
  last_cursor: string | null;
  created_at: number;
}
