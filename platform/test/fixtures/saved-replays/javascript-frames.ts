// Prior retained visual analysis from JavaScript turn 2. Diagnostic fields, image locators and billing entries removed; observations and caveats unchanged.
export default {
  "assetVersions": [
    "bea7c3df249a1d8b29d84d848806102f29ebbb95ffd835d243c73e90233e6a3b",
    "822651ed0602f9800f1812387b6bb7ec90c563df166ab5b9edd8f877b5597daf",
    "5797e2e1d8fa5c6775ec5cd8d68a7bf39ba70e5fb175115de562c52b3d6162fa",
    "b6bdc2f24bcd1eecee9961529d69a9feeb7a44090295d47ce56d1211d3e1caa5"
  ],
  "packetId": "packet:97367bec-9459-4ea2-aa1c-11931b131d4c:chatcmpl-tool-89764ebb4767f1c7",
  "kind": "youtube_frames",
  "sources": [
    {
      "id": "youtube:DC471a9qrU4:frames",
      "provider": "youtube",
      "kind": "frames",
      "videoId": "DC471a9qrU4",
      "url": "https://www.youtube.com/watch?v=DC471a9qrU4"
    }
  ],
  "excerpts": [
    {
      "id": "evidence:2526d550da3c121e58dec7c883782e3898e665050a43b6e53c976bbc0187814a:0",
      "sourceId": "youtube:DC471a9qrU4:frames",
      "text": "Visual observation at requested frame 0:15: Title card shows only the word \"LOOP\" in large yellow 3D letters on a black background; no code is visible.",
      "startMs": 15000,
      "endMs": 15000
    },
    {
      "id": "evidence:2526d550da3c121e58dec7c883782e3898e665050a43b6e53c976bbc0187814a:1",
      "sourceId": "youtube:DC471a9qrU4:frames",
      "text": "Visual observation at requested frame 0:30: VS Code editor tab \"map.js\" shows a for-of loop example: \"const usernames = [];\" followed by \"for (const user of users) {\" with an autocomplete suggestion \"usernames\" inside the loop body; no map call or output is visible.",
      "startMs": 30000,
      "endMs": 30000
    },
    {
      "id": "evidence:2526d550da3c121e58dec7c883782e3898e665050a43b6e53c976bbc0187814a:2",
      "sourceId": "youtube:DC471a9qrU4:frames",
      "text": "Visual observation at requested frame 1:15: VS Code editor tab \"map.js\" shows a JSX-style map example: \"const ui = users.map(user => <h1> {user.username} </h1> )\"; no console output or mutation demonstration is visible.",
      "startMs": 75000,
      "endMs": 75000
    },
    {
      "id": "evidence:2526d550da3c121e58dec7c883782e3898e665050a43b6e53c976bbc0187814a:3",
      "sourceId": "youtube:DC471a9qrU4:frames",
      "text": "Visual observation at requested frame 1:26: VS Code editor tab \"map.js\" shows an async map example: \"const requests = users.map(user => fetch(user.name) )\" with a lightbulb icon, followed by \"await Promise.all(requests)\"; no output or mutation of the original array is shown.",
      "startMs": 86000,
      "endMs": 86000
    },
    {
      "id": "evidence:2526d550da3c121e58dec7c883782e3898e665050a43b6e53c976bbc0187814a:4",
      "sourceId": "youtube:DC471a9qrU4:frames",
      "text": "Shared visual observation, reported as visible in each of the requested frames at 0:30, 1:15, 1:26: The editor tab is labeled \"map.js\" with a yellow JS icon in a dark VS Code theme.",
      "startMs": 30000,
      "endMs": 86000
    }
  ],
  "artifacts": [
    {
      "type": "youtube_frame_analysis",
      "title": "Frame analysis for DC471a9qrU4",
      "data": {
        "videoId": "DC471a9qrU4",
        "requestedTimestampsMs": [
          15000,
          30000,
          75000,
          86000
        ],
        "frames": [
          {
            "timestampMs": 15000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          },
          {
            "timestampMs": 30000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          },
          {
            "timestampMs": 75000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          },
          {
            "timestampMs": 86000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          }
        ],
        "failures": [],
        "focus": "Read the exact on-screen JavaScript code in these frames: the map.js editor code (users.map example), any earlier map example code, and the side effect code. Quote code exactly as legible, note visible output, and whether anything shows map mutating the original array or callback side effects on objects.",
        "provenanceVersion": 2
      }
    },
    {
      "type": "youtube_frame_retrieval",
      "title": "Selected frames for DC471a9qrU4",
      "data": {
        "videoId": "DC471a9qrU4",
        "requestedTimestampsMs": [
          15000,
          30000,
          75000,
          86000
        ],
        "frames": [
          {
            "timestampMs": 15000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          },
          {
            "timestampMs": 30000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          },
          {
            "timestampMs": 75000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          },
          {
            "timestampMs": 86000,
            "mimeType": "image/jpeg",
            "width": 1920,
            "height": 1080,
            "sourceWidth": 1920,
            "sourceHeight": 1080
          }
        ],
        "failures": []
      }
    }
  ],
  "warnings": [
    {
      "code": "SELECTED_FRAME_EVIDENCE",
      "message": "Observations cover selected still frames only. Timestamps identify requested seek positions."
    },
    {
      "code": "SELECTED_FRAME_EVIDENCE",
      "message": "Observations cover selected still frames only."
    }
  ],
  "usage": []
};
