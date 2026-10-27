// Prior retained visual analysis from JavaScript turn 2. Diagnostic fields, image locators and billing entries removed; observations and caveats unchanged.
export default {
  "assetVersions": [
    "66cf2ee9d38da0de74ef37276d7c5ce4109101cedd08859fdd3ff7948e3800aa",
    "9e45881925bafe493a8aa410a203c56f002f322cc7c8f13d599a86344b3ee279",
    "6e92c25e89e1b3ab2edafe9639914ba6f2d4b8d4712935a8754d56b56081fb25",
    "49ce0a02f25bdefe6cd9af15dc59c4abb84fec3618c4246bf28c6bf8af379c4e",
    "5b9fb54e6a98862e8fb74b88753242f5ca294ba8728c6a073b428dbd9abf8de9",
    "005724f4ffbe2b4df832ed862b7c50528626a538dc915ad1c927afe92fe92822"
  ],
  "packetId": "packet:97367bec-9459-4ea2-aa1c-11931b131d4c:chatcmpl-tool-b2b101186f527cb8",
  "kind": "youtube_storyboard",
  "sources": [
    {
      "id": "youtube:DC471a9qrU4:storyboard",
      "provider": "youtube",
      "kind": "storyboard",
      "videoId": "DC471a9qrU4",
      "url": "https://www.youtube.com/watch?v=DC471a9qrU4"
    }
  ],
  "excerpts": [
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:0",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Visual observation at sampled frame 0:01: Title card reading \"Array.prototype.map()\" on a dark background (frame 1, ~1s).",
      "startMs": 1000,
      "endMs": 1000
    },
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:1",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Visual observation at sampled frame 0:02: On-screen text: \"Create a new Array[] by calling a function on each element in a different Array[]\", with a diagram of colored squares (yellow, green, magenta) and \".map(fn)\" (frame 2, ~2s).",
      "startMs": 2000,
      "endMs": 2000
    },
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:2",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Visual observation at sampled frame 1:15: VS Code editor (map.js) showing code approximately: \"const requests = users.map(user => fetch(user.url))\" — a map call over a users array returning fetch promises (frame 75, ~75s).",
      "startMs": 75000,
      "endMs": 75000
    },
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:3",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Visual observation at sampled frame 1:20: VS Code editor showing \"await Promise.all(requests)\" beneath the requests map code (frame 80, ~80s).",
      "startMs": 80000,
      "endMs": 80000
    },
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:4",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Visual observation at sampled frame 1:26: VS Code editor showing \"const sideEffect = () => { console.log('SIDE EFFECT BRO!') }\" with a red radioactive warning symbol overlaid on the right side of the screen (frame 86, ~86s).",
      "startMs": 86000,
      "endMs": 86000
    },
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:5",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Shared visual observation, reported as visible in each of the sampled frames at 0:38, 0:39: Full-screen text card reading \"im·per·a·tive — use statements to mutate state\".",
      "startMs": 38000,
      "endMs": 39000
    },
    {
      "id": "evidence:15c3fd618eec5051793cf5bf41dc1ee0494b429cc2793da3640a6e4336856f63:6",
      "sourceId": "youtube:DC471a9qrU4:storyboard",
      "text": "Shared visual observation, reported as visible in each of the sampled frames at 0:41, 0:42: Full-screen text card reading \"de·clar·a·tive — use functions to describe state\".",
      "startMs": 41000,
      "endMs": 42000
    }
  ],
  "artifacts": [
    {
      "type": "youtube_storyboard_analysis",
      "title": "Storyboard analysis for DC471a9qrU4",
      "data": {
        "videoId": "DC471a9qrU4",
        "sampledRanges": [
          {
            "startMs": 0,
            "endMs": 24000
          },
          {
            "startMs": 25000,
            "endMs": 49000
          },
          {
            "startMs": 50000,
            "endMs": 74000
          },
          {
            "startMs": 75000,
            "endMs": 99000
          },
          {
            "startMs": 100000,
            "endMs": 101000
          }
        ],
        "totalFrames": 102,
        "sampledFrames": 102,
        "intervalMs": 1000,
        "focus": "Find on-screen JavaScript code examples demonstrating array map. Report the exact code shown, any visible output, and the timestamp of each sheet/tile where code appears.",
        "provenanceVersion": 2
      }
    },
    {
      "type": "youtube_storyboard_retrieval",
      "title": "Sampled visual evidence for DC471a9qrU4",
      "data": {
        "videoId": "DC471a9qrU4",
        "sampledRanges": [
          {
            "startMs": 0,
            "endMs": 24000
          },
          {
            "startMs": 25000,
            "endMs": 49000
          },
          {
            "startMs": 50000,
            "endMs": 74000
          },
          {
            "startMs": 75000,
            "endMs": 99000
          },
          {
            "startMs": 100000,
            "endMs": 101000
          }
        ],
        "totalFrames": 102,
        "sampledFrames": 102,
        "intervalMs": 1000
      }
    }
  ],
  "warnings": [
    {
      "code": "SAMPLED_VISUAL_EVIDENCE",
      "message": "Observations cover sampled storyboard frames only. Brief events and small text may be missed."
    },
    {
      "code": "VISUAL_ANALYSIS_WARNING",
      "message": "Code text in the editor tiles is small (160x90 px tiles); exact identifiers and punctuation are partially legible and quoted code is approximate."
    }
  ],
  "usage": []
};
