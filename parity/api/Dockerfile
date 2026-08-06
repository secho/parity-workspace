FROM node:22-alpine

WORKDIR /app

COPY package.json ./
# NOT --omit=optional. The Agent SDK ships its native CLI as a per-platform optional
# dependency; omitting it installs cleanly and then fails at the first agent run with
# "Native CLI binary for linux-arm64 not found". The monolith's Dockerfile omits
# optionals safely because it has no such dependency — this one must not.
RUN npm install

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

EXPOSE 3000
CMD ["npx", "tsx", "watch", "src/server.ts"]
