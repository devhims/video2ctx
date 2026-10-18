# Visual inspection and evidence checks

The hosted agent now records the difference between the images it received, the findings it reported, and the operations performed in the current turn. Follow-up answers use those records even when routed as conversation history only.

Our application controls tool access, saved evidence, frame mappings, answer acceptance and memory writes. YouTube supplies metadata, captions and storyboard images. Models choose inspection requests and interpret images. A model interpretation can still be wrong; the new check is a separate model review, not a mathematical proof of the answer.

## Workflow

The internal [visual-inspection skill](../../platform/src/agents/research/skills/visual-inspection/SKILL.md) is included when the research route allows visual evidence. It reuses adequate saved analysis, uses publisher timestamps or captions when they help locate a subject, and uses storyboard overviews when the location is unclear. Exact frames resolve small text, conflicting names or inadequate thumbnails. It does not require every visual question to fetch captions and storyboards.

For example, the replay used a 10-second storyboard grid. A supplied opening sheet contains both 3:20 and 3:30. An analyst mentioning one timestamp in a finding does not mean the other image was excluded. The application now lists every supplied image position separately from reported observation times. An answer that invents an exclusion or an undocumented selection reason can be rejected before persistence.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'actorBkg': '#e8eef6', 'actorTextColor': '#172b4d', 'actorBorder': '#52657a', 'signalColor': '#52657a', 'signalTextColor': '#52657a', 'labelBoxBkgColor': '#172b4d', 'labelTextColor': '#ffffff', 'sequenceNumberColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    participant R as Research agent
    participant S as Saved evidence
    participant A as Image analyst
    participant F as Finalizer
    participant C as Evidence checker
    R->>S: Retrieve selected images and record choices
    S->>A: Supply exact saved image inputs
    A->>S: Save observations with frame citations
    S->>F: Supply admitted evidence and structural inspection records
    F->>C: Check draft against records and prior messages
    C-->>F: Accept or identify unsupported claims
    F->>S: Persist an accepted answer, then update memory
```

## Boundaries

- Exact-frame selection notes bind one reason to each requested timestamp. Locating references must have been delivered for the same video. Historical requests without notes remain readable; the agent must state that reasons were not recorded.
- Structural inspection records have a 12,000-character content budget. They contain image positions, coverage and operation labels, without image observations or caption text. They do not bypass paid evidence admission.
- The checker uses an independent, low-reasoning text model, at most 1,200 output tokens and 20 seconds within the existing answer deadline. Its cost uses the existing finalization category and run cost limit. Inspection failures share the existing single answer-repair allowance. A rejected or unchecked answer is not persisted. Streamed text remains provisional until the checker accepts it.
- Context and unresolved-question memories store verified user quotes instead of generated paraphrases. Cited findings still rely on semantic grounding. Updater version 2 skips pending jobs from version 1; existing memory is not backfilled.
- `SKILL.md` is authoritative. The generated TypeScript bundle is checked by the platform build and regenerated with `npx tsx scripts/generate-agent-skills.ts`.

## Local replay

`npm run test:agent:visual-replay` in `platform/` is opt-in and makes paid model calls. Set `AGENT_REPLAY_ENV_FILE` to the local secret file, `AGENT_REPLAY_FIXTURES` to the saved public metadata/captions directory, and `AGENT_REPLAY_OUTPUT` to the replay asset/output directory. The latter contains `original-frames.json` and `public-storyboard.json` with local image paths. No credentials or images are committed.

The replay executes the four original questions sequentially with real Fireworks models, actual SQLite session storage and live memory updates. It separately challenges the checker with the original six-frame record. It uses saved public provider responses, not production Durable Object execution or credit settlement. Worker integration tests cover those storage and billing boundaries separately.
