# Affirm Gen Studio render worker (Remotion + Chrome). Deploy this folder as its own service (Railway/Fly/Render).
FROM node:22-bookworm-slim

# Chrome's shared-library dependencies (Remotion downloads its own headless shell at first start).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 \
    libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 libgtk-3-0 ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src

# Fetch the headless browser at build time so the first render is fast.
RUN npx remotion browser ensure || true

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
