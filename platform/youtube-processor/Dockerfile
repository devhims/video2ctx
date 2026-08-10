FROM node:22-slim AS library-build

WORKDIR /library

COPY packages/all-things-youtube/package*.json ./
RUN npm ci

COPY packages/all-things-youtube/tsconfig.json ./tsconfig.json
COPY packages/all-things-youtube/src ./src
RUN npm run build

FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY platform/youtube-processor/package*.json ./
RUN npm ci --omit=dev

COPY --from=library-build /library/dist ./node_modules/all-things-youtube/dist
COPY --from=library-build /library/package.json ./node_modules/all-things-youtube/package.json
COPY platform/youtube-processor/*.mjs ./

USER node
EXPOSE 8080

CMD ["node", "server.mjs"]
