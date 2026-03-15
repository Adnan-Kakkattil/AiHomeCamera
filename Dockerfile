FROM node:20-bookworm-slim

WORKDIR /app

# Install FFmpeg required by server.js
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure runtime directories exist
RUN mkdir -p /app/streams /app/recordings

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
