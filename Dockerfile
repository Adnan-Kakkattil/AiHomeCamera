FROM node:20-bookworm-slim

WORKDIR /app

# Install FFmpeg + build toolchain for native modules (sqlite3)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm_config_build_from_source=true npm ci --omit=dev \
    && npm rebuild sqlite3 --build-from-source

COPY . .

# Ensure runtime directories exist
RUN mkdir -p /app/streams /app/recordings /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
