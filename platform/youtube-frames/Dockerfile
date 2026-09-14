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

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY platform/youtube-frames/*.mjs ./
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
