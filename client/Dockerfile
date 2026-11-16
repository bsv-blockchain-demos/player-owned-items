# Build context: repo root (the client build imports shared/).
FROM node:22.23.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci
COPY shared/ shared/
COPY client/ client/
# Empty VITE_API_BASE = same origin (the ingress routes /api to the backend).
ARG VITE_API_BASE=
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run client:build

FROM node:22.23.4-alpine
RUN npm install -g serve@14.2.8
WORKDIR /app
COPY --from=build /app/client/dist .
USER node
EXPOSE 3000
CMD ["serve", "-s", ".", "-l", "3000"]
