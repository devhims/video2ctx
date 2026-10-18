# Visual inspection and direct answers

The hosted agent records the images it received, the findings it reported, and the operations performed in each turn. Ordinary answers present findings with citations and material uncertainty. Recorded workflow details are used when the user explicitly asks how the answer was obtained.

Our application controls tool access, saved evidence, frame mappings, structured answer validation and memory writes. YouTube supplies metadata, captions and storyboard images. Models choose inspection requests and interpret images. There is no separate model-based inspection checker. Answer guidance and structural validation cannot independently prove that an image interpretation is correct.

## Workflow

The internal [visual-inspection skill](../../platform/src/agents/research/skills/visual-inspection/SKILL.md) is included when the research route allows visual evidence. It reuses adequate saved analysis, uses publisher timestamps or captions to locate subjects, and uses storyboard overviews when the location is unclear. Exact frames resolve small text, conflicting names or inadequate thumbnails. Captions and storyboards are retrieved when they help answer the question.

For example, if a user asks what the presenter holds at 3:20, the answer describes the visible object and cites that frame. It omits unsolicited statements about checking transcripts or inspecting frames. If the user later asks why 3:20 was chosen, the answer uses the recorded selection notes and states when the reason is unknown.

A storyboard sheet can contain both 3:20 and 3:30 even when a finding mentions only one. Records distinguish all image positions supplied to the analyst from the timestamps in reported findings. That distinction supports workflow explanations without implying that an unmentioned tile was excluded.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'actorBkg': '#e8eef6', 'actorTextColor': '#172b4d', 'actorBorder': '#52657a', 'signalColor': '#52657a', 'signalTextColor': '#52657a', 'labelBoxBkgColor': '#172b4d', 'labelTextColor': '#ffffff', 'sequenceNumberColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    participant R as Research agent
    participant S as Saved evidence
    participant A as Image analyst
    participant F as Finalizer
    R->>S: Retrieve selected images and record choices
    S->>A: Supply saved image inputs
    A->>S: Save observations with frame citations
    S->>F: Supply admitted evidence and recorded context
    F->>S: Persist after structure and citation validation
    S->>S: Update memory separately
```

## Boundaries

- Exact-frame selection notes bind one reason to each requested timestamp. Locating references must have been delivered for the same video. Historical requests without notes remain readable; a requested workflow explanation should state that the reasons are unknown.
- Structural inspection records have a 12,000-character content budget. They contain image positions, coverage and operation labels, without image observations or caption text. They do not bypass paid evidence admission.
- The finalizer writes the answer from prepared context. Existing schema, citation, budget and deadline checks remain. Invalid structured answers retain the existing single repair allowance. No additional reviewer model, reviewer prompt or semantic review rejection runs before persistence.
- Context and unresolved-question memories store verified user quotes, including quote-only upserts with omitted or empty generated text. Findings require nonempty text and admitted citations. Updater version 2 skips pending version 1 jobs; existing memory is not backfilled.
- `SKILL.md` is authoritative. The platform build checks its generated TypeScript bundle.

## Local replay

`npm run test:agent:visual-replay` in `platform/` is opt-in and makes paid model calls. Set `AGENT_REPLAY_ENV_FILE` to the local secret file, `AGENT_REPLAY_FIXTURES` to the saved public metadata/captions directory, and `AGENT_REPLAY_OUTPUT` to the replay asset/output directory. The latter contains `original-frames.json` and `public-storyboard.json` with local image paths. No credentials or images are committed.

The replay executes the four original questions sequentially with real Fireworks models, SQLite session storage and live memory updates. It checks that the initial visual answer omits process narration, explicit workflow follow-ups remain answerable, all four turns complete and no inspection reviewer call is made. Provider responses use saved public video assets. This is local orchestration, without production Durable Object execution or credit settlement.
