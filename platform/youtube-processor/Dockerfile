FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package*.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts
RUN node -e "if (require('all-things-youtube').STORYBOARD_SELECTION_VERSION !== 2) throw new Error('The published extraction library must support storyboard metadata and explicit sheet selection.')"
COPY *.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
