FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY backend/migrations ./migrations
# config.js resolves ../../frontend from src/, so the frontend lives at /frontend.
COPY frontend /frontend

# The database volume is written here, so the app user must own this folder.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production

EXPOSE 3202

# Run as the unprivileged user that ships with the Node image.
USER node

CMD ["node", "src/server.js"]
