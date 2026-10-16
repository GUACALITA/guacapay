FROM node:20-alpine

WORKDIR /app

COPY gateway/package.json ./
RUN npm install --omit=dev

COPY gateway/src ./src

ENV NODE_ENV=production

EXPOSE 3203

# Run as the unprivileged user that ships with the Node image.
USER node

CMD ["node", "src/server.js"]
