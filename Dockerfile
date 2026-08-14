FROM node:24-bookworm-slim AS dependencies
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
# Environment-specific MCP endpoints are mounted at runtime. Never bake a
# developer's local MCP catalogue into the production image.
RUN mkdir -p .qasey && printf '{"servers":{}}\n' > .qasey/mcp.json
RUN pnpm build

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
ENV MASTRA_STUDIO_PATH=/app/.mastra/output/studio
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/dist ./dist
COPY --from=build /app/.qasey/mcp.json ./.qasey/mcp.json
USER node
EXPOSE 4111 3001
CMD ["node", ".mastra/output/index.mjs"]

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/dist ./dist
RUN corepack enable && git --version
USER pwuser
CMD ["node", "dist/worker.mjs"]
