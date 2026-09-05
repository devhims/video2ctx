# Research and inspection: current architecture and limits

Verified against the local implementation on 2026-09-05. This describes implemented behavior, including the reserved finalization window and partial-evidence fallback.

## Shared architecture

Both paths enter through POST /v1/agent. The request contains a message and optional conversation/parent identifiers; an Idempotency-Key header identifies an admission retry. Authentication and the credit balance check happen before durable admission. Local testing uses an explicitly enabled loopback authentication bypass.

The HTTP Worker checks access and admits the run into an AgentRuntimeDO, one durable runtime per user-scoped conversation. UserAccountDO maintains the user's session catalog. D1 stores identity, entitlements, and the credit ledger. AgentRuntimeDO SQLite stores runs, routes, evidence, tool calls, model usage, and events. The Agents SDK fiber handles execution and recovery. Recovery preserves the original admission deadline.

A classifier chooses topic_research, inspect_video, or clarification. The classifier and Agent Core receive bounded completed conversation history. The selected capability supplies instructions and a permitted tool set to the same ToolLoopAgent implementation. The classifier is a model call outside the Agent Core step count.

Workers AI performs model inference through the configured AI Gateway. The configured model is @cf/zai-org/glm-5.3-flash. Agent Core uses medium reasoning for research and low reasoning for inspection; classification, transcript analysis, and finalization use low reasoning.

Provider tools call the platform provider stack in process. Cache misses go through the YouTube processor container, which owns outbound YouTube calls. Postman does not call YouTube or Workers AI directly. Locally, the Docker/Wrangler egress bridge is an additional dependency; it has repeatedly failed while ordinary host HTTPS still worked.

## Research sequence

```mermaid
%%{init: {"themeVariables": {"signalColor": "#666666", "sequenceNumberColor": "#ffffff", "actorBkg": "#f3f4f6", "actorTextColor": "#111827", "actorBorder": "#6b7280"}}}%%
sequenceDiagram
    autonumber
    participant P as Postman
    participant R as Local API and durable runtime
    participant M as Workers AI
    participant Y as Provider stack and YouTube processor
    P->>R: POST message and idempotency key
    R-->>P: 202 with conversationId and runId
    R->>M: Classify request
    M-->>R: topic_research
    R->>M: Agent Core chooses search tools
    M-->>R: Search arguments
    R->>Y: Search YouTube
    Y-->>R: Candidate videos
    R->>M: Select videos and analysis focus
    M-->>R: Up to two distinct transcript-analysis requests
    par Analysis A
        R->>Y: Fetch transcript A
        Y-->>R: Complete timed transcript A
        R->>M: Isolated transcript analysis A
        M-->>R: Findings and selected window IDs
    and Analysis B
        R->>Y: Fetch transcript B
        Y-->>R: Complete timed transcript B
        R->>M: Isolated transcript analysis B
        M-->>R: Findings and selected window IDs
    end
    R->>R: Validate selections and persist exact excerpts
    R->>M: Synthesize from compact evidence
    M-->>R: Answer with excerpt markers
    R->>R: Resolve citations and persist result
    P->>R: GET run status
    R-->>P: Completed result, or partial result/failure
```

This is a typical successful flow, not a rigid script. Research still has a flexible model-driven tool loop. One search_youtube invocation is enforced per research run, including a failed invocation and across recovery. After use, the tool is removed from the next model step; an execution guard also blocks duplicate searches in the same batch. Provider-internal retries have separate behavior. The trends composite is no longer exposed to the agent. Metadata, comments, channel, and playlist tools may also be selected. The application enforces at most two distinct transcript-analysis semantic keys, currently video ID plus focus. Repeating identical input reuses evidence; changing focus can consume another slot for the same video.

## Inspection sequence

```mermaid
%%{init: {"themeVariables": {"signalColor": "#666666", "sequenceNumberColor": "#ffffff", "actorBkg": "#f3f4f6", "actorTextColor": "#111827", "actorBorder": "#6b7280"}}}%%
sequenceDiagram
    autonumber
    participant P as Postman
    participant R as Local API and durable runtime
    participant M as Workers AI
    participant Y as Provider stack and YouTube processor
    P->>R: POST request with a YouTube URL or ID
    R-->>P: 202 with conversationId and runId
    R->>R: Extract allowed video IDs
    R->>M: Classify with supplied IDs
    M-->>R: inspect_video and selected ID
    R->>R: Pin provider calls to that ID
    R->>M: Agent Core chooses video-specific tools
    M-->>R: Metadata, transcript, or other permitted calls
    R->>Y: Fetch requested video evidence
    Y-->>R: Metadata and complete timed transcript
    R->>M: Isolated transcript analysis
    M-->>R: Findings and selected window IDs
    R->>R: Validate and persist exact excerpts
    R->>M: Summarize compact evidence
    M-->>R: Answer with excerpt markers
    R->>R: Resolve citations and persist result
    P->>R: GET run status
    R-->>P: Completed result, or partial result/failure
```

Inspection uses transcripts, metadata, and optional sampled storyboard images. It does not accept local MP4 uploads. Its provider adapter rejects calls for another video. Missing or ambiguous video identification can route to clarification. It has no separate one-analysis-per-run cap; identical transcript requests are reused, while different focus requests remain subject to the shared time and tool budgets.

## Tool sets

| Tool | Research | Inspection |
|---|---|---|
| search_youtube | Yes | No |
| browse_youtube | Yes | No |
| get_video | Yes | Yes |
| get_video_transcript | Yes | Yes |
| get_video_comments | Yes | Yes |
| get_video_tracks | No | Yes |
| get_video_storyboard | Yes | Yes |
| get_channel | Yes | No |
| get_channel_videos | Yes | No |
| get_channel_playlists | Yes | No |
| get_playlist | Yes | No |
| finalize_answer | Yes | Yes |

Research has ten evidence tool types plus finalization. Inspection has five evidence tool types plus finalization. Number of tool types is different from number of permitted calls.

## Effective limits

| Limit | Current behavior |
|---|---|
| Total run deadline | 60 seconds from durable admission, including classification and recovery |
| Main phase | Ends by admission + 40 seconds; includes planning, tools, analyses, and any normal finalization |
| Forced early finalization | At a model-step boundary, when <=12 seconds remain in the main phase, nominal step 8 is reached, transcript/tool budget is exhausted, or estimated model cost reaches the reserve threshold |
| Reserved synthesis | At most 20 seconds, ending by admission +58.5 seconds; early phase termination can start this sooner |
| Persistence margin | Final 1.5 seconds before the outer deadline |
| Agent Core steps | Eight nominal; finalization is forced by the eighth. Stop ceiling is ten including two retry allowances. Time can stop execution much earlier |
| Durable tool calls | Twelve total: at most eleven evidence calls, reserving one successful finalization slot |
| Research transcript analyses | Two distinct video/focus requests; identical requests reuse results |
| Inspection video scope | Exactly one pinned video; no separate one-analysis cap |
| Research search_youtube calls | One per run, including failures |
| Provider concurrency | Four evidence executions |
| Analyst concurrency | Two isolated model analyses shared by transcript and visual analysts |
| Classifier timeout | 20 seconds, inside the total budget |
| Agent Core/finalizer output | 1,600 tokens per call |
| Analyst output | Up to five findings, three supporting windows per finding, 4,000 output tokens |
| Analyst own timeout | 90-second helper default, overridden in practice by the earlier parent phase/run cancellation |
| Tool-argument repair | Separate model call, 15-second own timeout and 2,000 output tokens, still bounded by parent cancellation |
| Answer length | Under 180 words is prompt guidance, not a validator-enforced limit |
| Model cost | $1 estimated admission budget; $0.10 reserved threshold for finalization. This uses locally configured token prices and completed usage, not a hard vendor billing ceiling |
| Conversation memory | Up to eight completed ancestor turns, bounded to 64,000 characters |
| Recovery evidence prompt | Up to 40,000 characters of compact evidence |

The generic Agent Core helper still has a 90-second default. Both public paths override it with the remaining main-phase budget. Neither that default nor the analyst's 90-second helper timeout grants extra time to these endpoints.

## Finalization and fallback

```mermaid
%%{init: {"themeVariables": {"signalColor": "#666666", "sequenceNumberColor": "#ffffff", "actorBkg": "#f3f4f6", "actorTextColor": "#111827", "actorBorder": "#6b7280"}}}%%
sequenceDiagram
    autonumber
    participant R as Runtime
    participant M as Workers AI
    participant V as Citation validator and storage
    alt Normal finalize_answer succeeds in main phase
        R->>V: Validate answer markers and save
        V-->>R: completed
    else Main phase expires or produces no valid answer
        R->>R: Abort main-phase work at or before 40s
        R->>M: One bounded synthesis from saved evidence
        alt Valid synthesis before cutoff
            M-->>R: Answer with markers
            R->>V: Validate and save
        else Synthesis fails, stalls, or has invalid citations
            R->>R: Build labelled source-excerpt collection
            alt Usable evidence exists
                R->>V: Validate excerpts and save partial result
                V-->>R: completed, low confidence, PARTIAL_EVIDENCE
            else No usable evidence
                R-->>R: failed with retrieval/finalization error
            end
        end
    end
```

The finalizer resolves inline excerpt IDs against saved source records and exact text. The application constructs the returned citations; the model no longer duplicates packet/source declarations. Unknown or conflicting references are rejected. These checks establish provenance, not the truth of a claim or the quality of an interpretation.

Partial results contain quoted source excerpts, not a model-invented recommendation. They use status completed, confidence low, and warning code PARTIAL_EVIDENCE. A complete answer may also have low confidence for other reasons; use the warning code to identify this fallback.

## What the response counters mean

modelStepCount counts completed Agent Core steps. Classifier calls, transcript analyst calls, argument repair calls, reserved finalizer calls, retries inside model requests, and interrupted steps do not all appear in this number. A step can ask for multiple tools.

toolCallCount counts durable tool-call rows. Failed evidence calls count. Successful finalization counts. Rejected finalization attempts are not stored as completed tool rows. Reused evidence may avoid another row. Provider-internal HTTP retries do not appear as separate tools: one search call can cause multiple YouTube attempts and processor-slot retries.

The recovery finalizer and deterministic fallback occur outside Agent Core's step ceiling. Their successful persistence uses the same finalization budget and deadline checks.

## Remaining limitations

- Research sources are YouTube sources; this is not a general web/GitHub research engine.
- Minimal tools and short answers are instructions. The loop can deviate within its enforced budgets; the one-search_youtube limit is enforced in code.
- Two short analyses trade breadth for latency. Long transcripts and slow inference can still lead to partial results.
- Saved evidence is required for a useful fallback. Total retrieval failure cannot produce a supported answer.
- The recurring local Docker egress reset affects both paths on cache misses. Remote model availability is another independent dependency.
- Deadline enforcement ends application processing and blocks late finalization; it cannot guarantee an external service has stopped all work already sent to it.
- Agent responses expose calculated provider-credit usage. Full durable credit reservation/settlement is not implemented in this agent runtime.

## Source map

- Admission and polling: platform/src/routes/agent/agent.index.ts
- Durable state and execution: platform/src/agents/agent-runtime-do.ts
- Capability selection: platform/src/agents/research/capability-router.ts
- Shared orchestration: platform/src/agents/research/research-agent.ts
- Main loop: platform/src/agents/agent-core.ts
- Step/tool decisions: platform/src/agents/runtime/loop-control.ts
- Deadline enforcement: platform/src/agents/runtime/deadline.ts
- Transcript extraction: platform/src/agents/providers/youtube/transcript-analyst.ts
- Citation assembly: platform/src/agents/finalizer.ts
- Partial result: platform/src/agents/research/evidence-fallback.ts

## Storyboard evidence

Both paths can call `get_video_storyboard(videoId, focus)`. The processor uses published `all-things-youtube@0.4.0` to fetch up to two leading contact sheets. Temporary files are deleted on success and failure. Only bounded JPEG bytes and frame mappings reach the Worker; paths and signed image URLs do not reach the main agent.

An isolated GLM-5.3-Flash model reads the images and returns at most five visual findings, each tied to up to three supplied frame indexes. The application validates indexes and computes timestamps from the original mapping. Visual observations are labelled as such, rather than represented as transcript quotations. Raw images are not stored in evidence packets. This is sampled coverage, and two leading sheets may cover only the beginning of a long video.

The visual call has a 20-second timeout, no automatic model retry, and shares the collection phase's cancellation signal. All agent model calls, including visual and transcript analysis, use the shared GLM model factory and GLM pricing. Visual analysis uses low reasoning effort and the run session affinity. The existing total run deadline and finalization reserve remain unchanged. The removed agent tools do not remove the standalone public endscreen or trends API routes.

## Production access and rollout

All `/v1/agent` and `/v1/agent/*` requests first require the existing Better Auth principal and data-read permission for scoped credentials. A shared server-side gate then checks:

- `AGENT_RUNTIME_ENABLED=false`: disable all agent routes with `503 AGENT_DISABLED`.
- `AGENT_RUNTIME_ENABLED=true`, `AGENT_ACCESS_MODE=admins`: only accounts whose current, verified Better Auth email is in `ADMIN_EMAILS_SECRET` can use agent routes. Others receive `403 ADMIN_REQUIRED`.
- `AGENT_RUNTIME_ENABLED=true`, `AGENT_ACCESS_MODE=all`: allow authenticated users with the required credential scope. Account ownership and credit checks still apply.

Missing access mode defaults to `admins`. An invalid mode or unavailable account lookup fails closed. The current production configuration enables the admin rollout and uses the private `ADMIN_EMAILS_SECRET` Worker secret for its allowlist. The authenticated account ID resolves the email from the database on every restricted request, covering browser sessions, CLI sessions, and API keys without trusting a supplied email header or cached admin claim.

This uses a private email allowlist and Better Auth user records; it does not install Better Auth's separate admin-management plugin or create new administrative APIs. No auth schema migration is required. For unauthenticated local Postman testing, explicitly set `AGENT_ACCESS_MODE=all` along with the existing local-only authentication bypass. Production never permits that bypass.

These settings take effect when the platform is deployed; changing checked-in configuration alone does not update a running production Worker.

Set the allowlist with `npx wrangler secret put ADMIN_EMAILS_SECRET` from `platform/` and enter the value at the prompt. Never place its value in Wrangler vars, fixtures, or documentation. For local admin testing, set it in the ignored `.dev.vars` file.
