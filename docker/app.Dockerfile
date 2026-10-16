FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/src ./src
# config.js resolves ../../frontend from src/, so the frontend lives at /frontend.
COPY frontend /frontend

ENV NODE_ENV=production

EXPOSE 3202

CMD ["node", "src/server.js"]
