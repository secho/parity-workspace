FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["npx", "tsx", "watch", "src/index.ts"]
