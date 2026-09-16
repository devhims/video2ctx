FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package*.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.mjs ./
RUN node --input-type=module -e "import sharp from 'sharp'; import { getStoryboardWithFallback } from './storyboard-extractor.mjs'; if (!sharp.versions.webp || typeof getStoryboardWithFallback !== 'function') throw new Error('Storyboard runtime unavailable')"
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
