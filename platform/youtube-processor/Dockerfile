FROM node:22-slim AS library-build
WORKDIR /library
COPY packages/all-things-youtube/package*.json ./
RUN npm ci --ignore-scripts
COPY packages/all-things-youtube/tsconfig.json ./
COPY packages/all-things-youtube/src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /workspace/platform/youtube-processor
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=library-build /library/package.json /workspace/packages/all-things-youtube/package.json
COPY --from=library-build /library/dist /workspace/packages/all-things-youtube/dist
COPY platform/youtube-processor/package*.json platform/youtube-processor/.npmrc ./
RUN npm ci --omit=dev --ignore-scripts
RUN node -e "if (require('all-things-youtube').STORYBOARD_SELECTION_VERSION !== 2) throw new Error('The built extraction library must support storyboard metadata and explicit sheet selection.')"
COPY platform/youtube-processor/*.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
