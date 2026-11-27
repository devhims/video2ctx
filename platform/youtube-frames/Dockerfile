# The bundle and production dependencies are JavaScript-only. Build them on
# the host architecture; the final stage uses the deployment target platform.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
COPY platform/youtube-frames/package*.json ./
RUN npm ci
COPY platform/youtube-frames/build.mjs ./
COPY packages/youtube-skills/src/transport.ts ./skill-source/
COPY packages/youtube-skills/src/watch/ ./skill-source/watch/
RUN npm run build && npm prune --omit=dev

FROM brainicism/bgutil-ytdlp-pot-provider:2.0.2-node@sha256:d7d34108b76e52c7d3b575fe9e797e4bf41c1b2a08f80c5292eff6f851ce8472
USER root
WORKDIR /frames
ENV NODE_ENV=production
ENV PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3-venv tini \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/playback && /opt/playback/bin/pip install --no-cache-dir \
    yt-dlp==2026.10.26 yt-dlp-ejs==0.8.0 bgutil-ytdlp-pot-provider==2.0.2
ENV PATH="/opt/playback/bin:${PATH}"
ENV ATTESTATION_PROVIDER_PATH=/app/build/main.js
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY platform/youtube-frames/*.mjs platform/youtube-frames/attested-player.py ./
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
