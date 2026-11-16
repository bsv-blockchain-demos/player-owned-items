# Build context: repo root (server imports shared/ and resolves @server/* and @shared/* via the root tsconfig).
FROM node:22.23.4-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci --omit=dev -w @mb/server -w @mb/shared
COPY shared/ shared/
COPY server/ server/
USER node
EXPOSE 4000
# Indexes are not created here: db:migrate is a manual step. Boot fails fast if they're missing.
CMD ["node_modules/.bin/tsx", "server/index.ts"]
