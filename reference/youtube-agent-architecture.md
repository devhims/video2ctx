# YouTube Agent architecture

These diagrams document the code currently implemented on the `feat/youtube-agent` branch. Planned interfaces are visually distinguished from active runtime paths.

## Diagram set

- [System architecture](youtube-agent-system-architecture.html): current code topology, per-user session catalog, per-conversation runtime, public API edge, active tools, and storage.
- [Control boundaries](youtube-agent-control-boundaries.html): responsibility stack separating model choices from application-enforced limits, persistence, validation, and provider behavior.
- [Capability routing](youtube-agent-capability-routing.html): the first semantic step that turns one prompt into a `topic_research` configuration, an `inspect_video` configuration, or a clarification response.
- [Research loop](youtube-agent-research-loop.html): the main model's query, candidate selection, per-video transcript analysis, comparison, and gap-finding cycle around accumulated evidence.
- [Topic-research sequence](youtube-agent-topic-research-architecture.html): chronological flow inside Agent Core after routing, including durable tool calls, isolated transcript analysis, and finalization.
- [Evidence provenance](youtube-agent-evidence-provenance.html): transformation from untrusted provider values through analyst-selected exact excerpts to bounded packets, citation references, and the structured result.
- [Run lifecycle](youtube-agent-run-lifecycle.html): durable run states, checkpoints, cancellation, and fiber recovery.
- [Durable state](youtube-agent-durable-state.html): logical records in Durable Object SQLite and their relationships.
- [Live test seam](youtube-agent-live-test-architecture.html): the historical smoke-test diagram; the current test calls the local Worker HTTP API.
- [Agent budget enforcement](engineering/AGENT_BUDGET_ENFORCEMENT.md): the failure that caused `AGENT_DID_NOT_FINALIZE`, the runtime-enforced finalization and repair design, and the live Kimi test that verified it.

## Recommended reading order

1. Start with [System architecture](youtube-agent-system-architecture.html) for the deployment boundary and major components.
2. Read [Control boundaries](youtube-agent-control-boundaries.html) to separate model decisions from application guarantees.
3. Read [Capability routing](youtube-agent-capability-routing.html) to see how a run selects the configuration loaded into Agent Core.
4. Read [Research loop](youtube-agent-research-loop.html) for the topic branch's evidence-gathering logic.
5. Read [Topic-research sequence](youtube-agent-topic-research-architecture.html) for the runtime chronology inside that branch after routing.
6. Read [Evidence provenance](youtube-agent-evidence-provenance.html) to follow data into persisted packets and citation-checked output.
7. Read [Run lifecycle](youtube-agent-run-lifecycle.html) for status changes, cancellation, checkpoints, and recovery.
8. Read [Durable state](youtube-agent-durable-state.html) when you need the SQLite record model behind those behaviors.
9. Finish with [Live test seam](youtube-agent-live-test-architecture.html) to understand what the current smoke test proves and what it bypasses.

## Current implementation boundary

`POST /v1/agent` authenticates the caller, validates an idempotency key, establishes or reuses a conversation, checks the current credit balance, and invokes `AgentRuntimeDO.startRun()`. New conversations receive separate Durable Object identities. Follow-up calls route back to the same user-scoped conversation object. Admission assigns and returns a stable `userMessageId`, `assistantMessageId`, and `conversationTurn` with the run receipt. The receipt also exposes `modelStepCount` for completed Agent Core model steps and `toolCallCount` for persisted tool calls. After admission, the route records a bounded session projection in the authenticated user's `UserAccountDO`. `GET /v1/agent/sessions` lists that user's sessions by recent activity and optionally performs lexical FTS5 search over recorded user prompts. Opaque cursors provide pagination. This catalog does not use embeddings, semantic retrieval, or model context.

By default, a follow-up links to the latest completed assistant message. Clients can supply `parentMessageId` to continue from a specific completed turn. An implicit follow-up is rejected while another run is active, which prevents an ambiguous latest-parent choice; an explicit completed parent can start a deliberate branch. `GET /v1/agent/:conversationId/runs/:runId` retrieves the durable run state and terminal result. `GET /v1/agent/sessions/:conversationId` first verifies ownership through `UserAccountDO`, then reads a paginated message projection from the matching `AgentRuntimeDO`. It returns user and assistant messages in chronological order without old tool calls, evidence packets, routes, or internal events. After admission and fiber creation, a structured classifier selects `topic_research`, `inspect_video`, or `clarification`. The classifier and Agent Core both receive bounded memory from the selected chain of completed ancestors. The application persists the decision before constructing Agent Core. Fiber recovery reuses the stored parent chain and decision instead of selecting newer conversation state.

`AgentRuntimeDO` owns run state, fibers, recovery, idempotency, and limits. It delegates classification, capability setup, provider selection, transcript analysis, and Agent Core execution to the research module. Agent Core receives a ready model, message list, tool set, instructions, and finalization tool name. It does not import YouTube capabilities or provider tools. The current research module still selects YouTube directly. A future multi-provider classifier can move that choice into its route result without changing Agent Core or the durable runtime.

`UserAccountDO` is one plain SQLite-backed Durable Object per authenticated user. It owns session titles, latest user-message previews, run counts, recent-activity ordering, pagination, and a bounded lexical prompt index. It stores conversation and run identifiers but not transcripts, evidence packets, tool results, embeddings, or extracted user facts. Each `AgentRuntimeDO` remains the authoritative child for one conversation.

A reusable tool library maps each public YouTube provider operation to one agent tool:

1. `search_youtube`
2. `browse_youtube`
3. `research_youtube_trends`
4. `get_video`
5. `get_video_tracks`
6. `get_video_transcript`
7. `get_video_comments`
8. `get_video_endscreen`
9. `get_channel`
10. `get_channel_videos`
11. `get_channel_playlists`
12. `get_playlist`

`finalize_answer` is an application control tool, not a YouTube provider operation.

Capabilities load explicit subsets. `topic_research` receives ten provider tools plus `finalize_answer`; it omits caption-track and endscreen inspection. `inspect_video` receives five video-specific provider tools plus `finalize_answer`; it omits discovery, trends, channels, and playlists. Both branches run through the same durable executor and endpoint design. `inspect_video` has no separate admission route.

| Provider operation | Reusable tool | `topic_research` | `inspect_video` |
| --- | --- | --- | --- |
| Search | `search_youtube` | Yes | No |
| Browse category feed | `browse_youtube` | Yes | No |
| Topic trend report | `research_youtube_trends` | Yes | No |
| Video metadata | `get_video` | Yes | Yes |
| Caption tracks | `get_video_tracks` | No | Yes |
| Transcript | `get_video_transcript` | Yes | Yes |
| Comments | `get_video_comments` | Yes | Yes |
| Endscreen | `get_video_endscreen` | No | Yes |
| Channel metadata | `get_channel` | Yes | No |
| Channel videos | `get_channel_videos` | Yes | No |
| Channel playlists | `get_channel_playlists` | Yes | No |
| Playlist | `get_playlist` | Yes | No |

Both capabilities also load `finalize_answer`.

The capability classifier is one structured model call bounded to 20 seconds, including retries. It remains cancellable and subject to provider errors. Deterministic URL parsing supplies the video IDs it may select. An `inspect_video` result must copy a supplied ID, and the scoped provider adapter rejects every later call for a different video. A request that cannot resolve its video produces a clarification result without constructing Agent Core or calling the provider.

Within `topic_research`, the main model decides how often to search and which videos require transcript analysis. For each selected video, `get_video_transcript` fetches the complete timed transcript and invokes `TranscriptAnalyst`. This is one isolated structured model call, not another Agent Core, Agent, or Durable Object. `inspect_video` uses the same bounded one-call analysis for its pinned video so a long raw transcript never enters Agent Core.

During `topic_research`, `TranscriptAnalyst` receives all normalized transcript segments plus the research question and focus. It returns a summary, findings, and segment IDs. The application rejects invented IDs, resolves accepted IDs against the original transcript, and persists the exact timestamped excerpts in a bounded evidence packet. The main model sees this compact packet rather than the complete transcript.

During `inspect_video`, the same `get_video_transcript` wrapper invokes `TranscriptAnalyst` once with the complete returned transcript and the user's inspection question. The durable evidence packet retains the exact selected excerpts for citation validation. Agent Core receives only the bounded summary, findings, evidence identifiers, and coverage metadata.

The application owns the phase limits: up to 40 seconds of research after classification, including provider fetches and transcript analysis, followed by up to 40 seconds of finalization. Classification has its own 20-second timeout. Saving has a separate 30-second persistence timeout. The application also enforces eight nominal Agent Core steps, twelve total tool calls, four concurrent provider operations, typed evidence packets, route and final-intent validation, citation validation, idempotency, and durable checkpoints.

Production model calls use Workers AI through the configured AI Gateway. Tool implementations call the existing provider stack in process. Each `AgentRuntimeDO` SQLite database stores agent runs, route decisions, tool calls, evidence packets, and product events. The Agents SDK stores its fiber ledger in that same conversation object. Each `UserAccountDO` has a separate SQLite database for its bounded session catalog and FTS5 index.

## Implemented and planned

| Area | Current status |
| --- | --- |
| `topic_research` capability | Implemented with ten provider tools plus `finalize_answer` |
| Structured capability classifier | Implemented before Agent Core construction, with persisted recovery reuse |
| Reusable provider tool library | Twelve public provider operations implemented one-to-one |
| Complete-video `TranscriptAnalyst` | Implemented as one isolated model call per selected transcript in both capabilities |
| Durable run admission and polling | Public routes implemented behind `AGENT_RUNTIME_ENABLED` |
| Cancellation, checkpoints, recovery | Cancellation is available through Durable Object RPC; checkpoints and recovery are internal |
| GLM live smoke test | Calls the local Worker HTTP API for research and transcript/storyboard inspection |
| `AGENT_RUNTIME_ENABLED` | Enabled in configuration, with `AGENT_ACCESS_MODE=admins` |
| Public agent admission and run retrieval | Implemented behind `AGENT_RUNTIME_ENABLED` |
| Per-user session list and lexical search | Implemented in `UserAccountDO` behind `AGENT_RUNTIME_ENABLED` |
| Conversation restoration | Implemented as a catalog-authorized, cursor-paginated message projection |
| Stable admission message identities | Implemented with user ID, assistant ID, and turn ordinal in every run receipt |
| Browser-session and API-key access | Implemented through the shared data-principal middleware |
| SSE product events and reconnection | Planned |
| `inspect_video` branch | Implemented with five pinned-video tools plus `finalize_answer` |
| Workflow escalation for long research | Planned |
| Credit reserve and D1 settlement | Reserves 22 credits before inference, settles persisted evidence once, and refunds unused credits on every terminal outcome |

## Source map

- Agent runtime and Durable Object schema: `platform/src/agents/agent-runtime-do.ts`
- User session catalog and lexical search: `platform/src/durable-objects/user-account.ts`
- Conversation restoration projection and cursor: `platform/src/agents/runtime/conversation-restoration.ts`
- Public admission, session listing, restoration, search, and run retrieval: `platform/src/routes/agent/agent.index.ts`
- Research-run assembly: `platform/src/agents/research/research-agent.ts`
- Structured capability classifier: `platform/src/agents/research/capability-router.ts`
- Capability-scoped provider guard: `platform/src/agents/research/capability-provider.ts`
- Agent Core: `platform/src/agents/agent-core.ts`
- Shared Workers AI model construction: `platform/src/agents/model.ts`
- Runtime budgets and memory: `platform/src/agents/runtime/`
- Complete-video transcript analyst: `platform/src/agents/providers/youtube/transcript-analyst.ts`
- Provider tool factory map: `platform/src/agents/providers/youtube/tool-library.ts`
- Provider-operation wrappers: `platform/src/agents/providers/youtube/tools/`
- Capability-specific tool lists: `platform/src/agents/research/capabilities/`
- Evidence and finalization contracts: `platform/src/agents/contracts.ts`
- Provider adapter: `platform/src/agents/providers/youtube/provider.ts`
- Deterministic finalizer: `platform/src/agents/finalizer.ts`
- Live smoke test: `platform/scripts/test-youtube-agent-live.ts`

## Conversation memory and storage rule

Conversation memory does not use D1 or `UserAccountDO`. Each completed `agent_runs` row is one durable user-assistant turn. Its `turn_ordinal` records admission order, and its `parent_message_id` points to the prior assistant message so branches remain isolated and recovery reconstructs the same ancestor chain. The classifier and Agent Core receive at most the eight most recent completed ancestors, capped at 64,000 characters. Only the assistant answer is replayed, not old tool traces or evidence packets. The restoration endpoint applies the same separation when producing UI messages. Agent Runtime tables also store route decisions, tool calls, evidence packets, and events in Durable Object SQLite. The Agents SDK stores fiber checkpoints in its own ledger in the same conversation object.

`UserAccountDO` stores a bounded projection used only by the session-list UI: first-prompt title, latest user-prompt preview, lexical prompt search text, identifiers, counts, and timestamps. None of those fields are injected into Agent Core. D1 remains the existing home for identity, entitlements, and the credit ledger. The agent reserves 22 credits before inference. Completed evidence operations are charged at their canonical prices, including when a run fails or is cancelled; unused credits are refunded. Settlement uses an idempotent D1 ledger entry, with a durable watchdog to recover abandoned runs and retry interrupted settlement. Results report the ledger balance observed at settlement, which can change with concurrent account activity.


## Deadline and citation assembly (September 2026)

Classification also gates scope and storyboard access. Unsupported tasks return a persisted `rejected` route and reason without constructing the research loop or fetching evidence. The public completed result uses `intent: rejected` in legacy format or `outcome: rejected` in compact format, with an `OUT_OF_SCOPE` warning. New executable routes require `useStoryboard`; false removes the visual tool from the model and disables provider access. True makes sampled visual inspection available within the same research budget. Legacy persisted routes without the flag retain their original tool set.

Classification, research, and finalization are separate phases. Classification has a 20-second timeout; research starts its 40-second clock only after routing completes. Finalization starts its own 40-second clock at handoff, including when research finishes early. Each deadline is saved in Durable Object SQLite and reused on recovery. Recovery during finalization skips research and uses the remaining finalization time. Abort signals cancel phase work, and a deadline race bounds non-cooperative calls. User cancellation and terminal-state checks still apply. Saving a validated answer has a separate 30-second timeout, and billing settlement is retried durably if needed. The three model phases total at most 100 seconds, but queueing and persistence can extend end-to-end completion.

The model supplies inline `[cite:<excerptId>]` markers. The application resolves each marker against persisted excerpts and their source records, derives the public citation list, and rejects unknown or conflicting excerpt identities. The model no longer supplies duplicate packet/source/excerpt declarations. If recovery fails, the public run error preserves the recovery error rather than masking it with the original timeout.


## Reserved finalization and partial evidence

Topic research targets two transcript analyses for focused questions and four for comparative questions. The research phase has an abortable cutoff 40 seconds after classification. A stalled provider/model call cannot consume the finalization window. Synthesis and any citation repair share one continuous finalization budget of up to 40 seconds from handoff. The durable watchdog checks the persisted phase deadlines plus the persistence allowance before cancelling abandoned work, so an alarm scheduled in an earlier phase cannot cancel a later phase prematurely.

If synthesis times out or cannot be validated within its budget, application code returns a clearly labelled partial collection of retrieved excerpts. It uses the regular persisted-evidence citation validator, low confidence, and the `PARTIAL_EVIDENCE` warning. It does not invent a ranking or portray excerpts as a completed synthesis. When no usable evidence exists, the run can still fail explicitly.


## Account deletion

Admissions register their conversation before starting a fiber, including runs whose session projection has not been written yet. Account deletion closes that registry, cancels and settles conversation runs, drains pending evidence calls, and clears prompts, evidence, model usage, events and session search data. Cleanup must succeed before the account row is deleted. Failed cleanup retains the registry for a retry. Only deletion tombstones remain to reject requests that were authenticated before deletion began.

## Current live smoke test

`npm --prefix platform run test:agent:live -- --help` shows configuration without making requests. The script calls a running local Worker over HTTP, so routing, GLM, transcript and visual analysts, processor access, persistence and billing follow the application path. It runs research and inspect tasks, requires citations and nonzero evidence charges, and requires a storyboard artifact for inspection. Set `AGENT_TEST_NON_ADMIN_TOKEN` to exercise admin denial against a local Worker in `admins` mode. Without it, the script explicitly reports that live check as skipped; automated route tests cover denial independently.
