# Shared video asset catalog

A video accumulates source evidence as callers request it. D1 locates the exact asset variant; R2 holds the payload and downloaded images. API requests, source imports, dashboard calls through the platform adapters, and agent provider calls use this path. A transcript request does not download comments, storyboards, or frames.

The application owns freshness, asset identity, coalescing, and persistence. The existing processor and frame containers own YouTube extraction. R2 and D1 do not perform extraction or analysis.

For example, a transcript request creates a video record and an English transcript reference. A later comments request adds a comments reference to that video. Another agent asking for the English transcript reads the existing complete object regardless of age.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'signalColor': '#334155', 'signalTextColor': '#334155', 'sequenceNumberColor': '#ffffff', 'actorBkg': '#e2e8f0', 'actorTextColor': '#0f172a', 'actorBorder': '#64748b'}}}%%
sequenceDiagram
    autonumber
    participant Caller as API or agent
    participant App as Platform
    participant DB as D1 catalog
    participant Store as R2 assets
    participant Source as YouTube containers
    Caller->>App: Request transcript for video ID and language
    App->>DB: Find exact asset variant
    alt Complete asset exists and no refresh requested
        App->>Store: Read referenced payload
        Store-->>App: Source evidence
    else Missing, incomplete, or explicit refresh
        App->>App: Coalesce identical requests in coordinator
        App->>Source: Extract requested resource
        Source-->>App: Source evidence
        App->>DB: Record pending version
        App->>Store: Write images, then JSON manifest
        App->>DB: Publish current pointer and mark version ready
    end
    App-->>Caller: Evidence and cache status
```

## Stored evidence

| Resource | Variant identity |
| --- | --- |
| Video metadata (`video_metadata`) | Video ID |
| Video signals | Video ID |
| Caption tracks | Video ID |
| Transcript | Language and granularity |
| Comment page | Continuation token |
| Collected comments | Page limit |
| Storyboard manifest | Video ID |
| Storyboard sheet | Manifest geometry hash and sheet index |
| Extracted frame | Requested timestamp and maximum width |
| Endscreen elements | Video ID |

Complete video resources are reused regardless of age. `fresh_until` and the legacy KV retention windows remain for compatibility, but do not trigger another video fetch. Missing resources are fetched independently. Requesting frames at 10 and 20 seconds after 10 seconds was already extracted downloads only the missing 20-second frame. Partial extraction preserves successful frames for subsequent requests.

Metadata, transcript and comments API routes accept `refresh=true`. A normal request reuses saved data; an explicit refresh fetches again and saves the result. Responses mark reused video data with `freshness.state=stored` and its original `freshness.fetchedAt`. Existing immutable session references remain readable after refresh.

Explicit comments import jobs fetch fresh comments. Sources requests fresh comments when the user opens a video with Comments selected, clicks the Comments tab, or loads another comment page. Restoring dashboard drafts and history uses the saved data. The agent classifier selects `refreshDynamicData` when the user asks for current views, likes or comments. That refreshes metadata, statistics and requested comments while continuing to reuse transcripts and images. Explicit requests to refresh all evidence retain the separate `refreshEvidence` behavior.

Trend research explicitly fetches current statistics. Failed or missing view counts exclude that video from the new snapshot, rather than recording saved counts under a new timestamp. Search, channel and playlist caches still use their existing expiration policy.

Metadata includes the fields returned by the provider, such as title, description, channel references and thumbnail URLs. Only returned image bytes are copied into R2. Referenced URLs are not automatically downloaded. Search, channel and playlist responses retain the existing KV path. Discovering a video in search does not proactively populate its catalog.

## Data layout

- `videos` has one case-sensitive primary key per video ID, first request time and last request time. Last request time is updated at most once per minute per active video. Session evidence reads also touch it, so it is approximate to a minute and contains no user identity.
- `video_assets` holds the current pointer for each `(video_id, kind, variant)`. The composite primary key supports exact lookups without scanning video histories.
- `video_asset_versions` retains payload versions and pending writes. Partial responses cannot replace complete current evidence; a late older response cannot replace a newer response of the same completeness.

There is one root row per video, plus multiple asset and version rows. Database sizing must count all of these rows and their indexes.

R2 object keys use these prefixes:

```text
youtube/videos/abcdefghijk/
  video_metadata/<variant-hash>/<payload-hash>.json
  transcript/<variant-hash>/<payload-hash>.json
  comments/<variant-hash>/<payload-hash>.json
  storyboard_manifest/<variant-hash>/<payload-hash>.json
  storyboard_sheet/<variant-hash>/<payload-hash>.json
  frame/<variant-hash>/<payload-hash>.json
  images/<image-hash>.jpg
```

A manifest references binary JPEG objects. Reads reconstruct the provider response expected by existing callers. Byte-identical payloads share a content hash. New snapshots remain available in the version inventory.

`video_metadata` means the get-video-details response, not a video file. Migration `0002_video_metadata_kind.sql` renames existing D1 asset and version records. Their R2 object keys stay unchanged, so historical objects under `video/` remain readable; new writes use `video_metadata/`. Reads also accept the legacy kind during rollout. The processor operation remains `video` for compatibility with its existing contract.

## Consistency and recovery

D1 and R2 have no cross-service transaction. The pending version is written first, followed by all images and then the manifest. A D1 batch publishes the pointer and marks the version ready. The hourly task reconciles up to 50 pending versions older than five minutes, independently of monitor reconciliation.

Missing objects and manifests with mismatched hashes cause a cache miss. Failed persistence returns an error instead of pretending the new evidence was saved. A normal upstream failure may serve existing evidence with `cacheStatus: stale`; an explicit refresh reports upstream failure. Partial sources are saved but never treated as fresh complete hits.

Complete legacy video KV entries are promoted on demand with their original fetch timestamp. API and agent helpers use the same canonical coordinator identity. When only historical imports exist, new reads can reuse the latest complete saved version without publishing a current pointer. Identical requests coalesce; overlapping but different frame or sheet batches may still perform duplicate extraction concurrently. Canceling a frame waiter does not cancel extraction shared with another caller; the container time budget still bounds it.

Recovery retains historical objects. Images written before a failed manifest write can remain unreferenced. There is no garbage collector or retention policy in this first version. Do not attach a blanket bucket expiration rule: it could delete current evidence. Add reference-aware cleanup and capacity monitoring before sustained large ingestion.

## Session boundary

Only reusable public provider evidence enters the shared catalog. Prompts, user IDs, private analysis, citations and conversation packets remain in the existing session store. Frame analysis still runs in the session against reusable source images. Deleting a session deletes its private evidence according to the existing lifecycle; it does not purge shared public video sources.

This version does not add timeline summaries, embeddings, similarity search or a catalog management API. Those can build on these durable source references. Existing session assets migrate lazily on read or when an active session inventory opens. Dormant sessions and historical run snapshots are not bulk backfilled.

Session references identify an exact `(video_id, kind, variant, content_hash)` in `video_asset_versions`. Reads verify the stored manifest hash and hydrate that version's images. They never follow `video_assets` to a newer payload. A small session-local envelope preserves the metadata the session originally received. The session's existing asset hash remains the citation identity.

Migration `0003_historical_asset_versions.sql` adds `publish_current` to the version journal. Legacy session imports write historical-only versions with `publish_current=0`; crash recovery can finish them without changing the public current pointer. A matching existing version is reused without renewing its timestamps. Live provider writes retain current-pointer publication.

For example, sessions A and B can both reference English transcript version H1. A refresh adds H2 to the catalog. Their existing citations still resolve H1. Deleting the asset in session A removes A's ownership, citations and dependent memory; session B and both shared versions remain intact.

```mermaid
%%{init: {'theme':'base','themeVariables':{'actorBkg':'#e2e8f0','actorTextColor':'#0f172a','actorBorder':'#64748b','signalColor':'#334155','signalTextColor':'#334155','sequenceNumberColor':'#ffffff','noteBkgColor':'#f1f5f9','noteTextColor':'#0f172a'}}}%%
sequenceDiagram
    autonumber
    participant User
    participant Session as Session Durable Object
    participant Catalog as Shared D1 catalog
    participant Assets as video2ctx-video-assets R2
    User->>Session: Retrieve transcript
    Session->>Catalog: Resolve or save public version H1
    Catalog->>Assets: Read or write immutable payload
    Catalog-->>Session: Exact version reference H1
    Session->>Session: Atomically save ownership and reference
    User->>Session: Read cited evidence
    Session->>Session: Verify session owns H1
    Session->>Catalog: Resolve H1, independent of current version
    Catalog->>Assets: Read H1
    Session-->>User: Evidence with stable citation IDs
    User->>Session: Delete this session asset
    Session->>Session: Remove ownership, citations and dependent memory
    Note over Catalog,Assets: Shared records and payloads remain available
```

The private `RESEARCH` binding points to `all-things-youtube-private`. New visual previews store revocable pointers there instead of copying shared JPEGs. Session deletion removes those pointers. Existing private previews and run snapshots keep their current lifecycle; only reusable raw session assets are migrated.

## Local setup and deployment

The dedicated bindings are `VIDEO_CATALOG` and `VIDEO_ASSETS`. Keeping them separate from account D1 and private research R2 allows independent capacity planning and retention. If both bindings are absent in older test environments, adapters retain their previous behavior. Configuring only one is an error.

From `platform/`:

```sh
npm run db:migrate:local
npm run test:video-catalog
npm run build
```

The local migration script applies account migrations and catalog migrations. For only the catalog, use `npm run db:catalog:local`. The agent Postman configuration uses the same catalog migration directory and local database ID.

The hosted production and preview databases and private R2 buckets are provisioned. `wrangler.jsonc` contains their real IDs and names; the catalog retains `remote: false` for local development. That flag does not change remote migration or deployment targets.

| Resource | Production | Preview |
| --- | --- | --- |
| D1 database | `video2ctx-video-catalog` | `video2ctx-video-catalog-preview` |
| D1 ID | `90fdc3eb-c76f-4dfe-a0cd-503f7606b4c3` | `1439902b-2ee3-4cb3-9719-d18b409cb62e` |
| Private R2 bucket | `video2ctx-video-assets` | `video2ctx-video-assets-preview` |

The initial catalog migration has been applied to both hosted databases. `deploy:production` applies both account and catalog migration sets; direct `deploy` does not apply migrations. Subsequent migration runs skip applied files. Self-hosted deployments must create their own resources, update the bindings, and apply the catalog migrations before deployment.

D1 is suitable for this initial exact-key catalog, but its [per-database size limit](https://developers.cloudflare.com/d1/platform/limits/) is 10 GB on Workers Paid. Millions of video roots do not imply millions of total rows. Measure database bytes, read latency, write queueing and asset/version counts during rollout. Plan sharding or PostgreSQL before the catalog approaches that limit. This implementation does not claim a measured production throughput or latency target.

The tests exercise real SQLite query plans, mixed complete/partial versions, concurrent misses, legacy promotion, refresh failure, missing objects, binary image reconstruction and interrupted commits. A separate Workers integration suite applies the actual migration to local D1 and writes and reads local R2 objects.
