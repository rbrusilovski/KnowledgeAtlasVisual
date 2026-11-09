# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && (corepack enable 2>/dev/null || npm i -g pnpm)
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm,target=/pnpm/store DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Build-time placeholders only: env.ts validates at import, but nothing here is inlined into client bundles and the
# real values are supplied at runtime (compose env_file / your orchestrator). Never put real secrets in build args.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build REDIS_URL=redis://localhost:6379 \
    BETTER_AUTH_SECRET=build-placeholder-build-placeholder-000 ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    pnpm prisma generate && \
    DATABASE_URL=postgresql://build:build@localhost:5432/build REDIS_URL=redis://localhost:6379 \
    BETTER_AUTH_SECRET=build-placeholder-build-placeholder-000 ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    pnpm build

FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]

FROM base AS worker
ENV NODE_ENV=production ATLAS_PROCESS=worker
COPY --from=build /app ./
CMD ["pnpm", "worker"]
