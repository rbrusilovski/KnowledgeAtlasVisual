# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable 2>/dev/null || npm i -g pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm prisma generate && pnpm build

FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]

FROM base AS worker
ENV NODE_ENV=production ATLAS_PROCESS=worker
COPY --from=build /app ./
CMD ["pnpm", "worker"]
