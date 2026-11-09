-- CreateEnum
CREATE TYPE "TranscriptVisibility" AS ENUM ('PRIVATE', 'CORPUS');

-- CreateEnum
CREATE TYPE "TranscriptKind" AS ENUM ('MANUAL', 'ASR', 'UPLOADED', 'FIXTURE');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('NOT_CHECKED', 'PENDING', 'AVAILABLE', 'NOT_AVAILABLE', 'FAILED', 'REQUIRES_USER_UPLOAD', 'NOT_ELIGIBLE_OWNER_CAPTIONS');

-- CreateEnum
CREATE TYPE "CoverageGroup" AS ENUM ('IDENTITY', 'TEXT', 'CHANNEL_PROFILE', 'THUMBNAILS', 'PUBLICATION', 'STATISTICS', 'STATUS', 'TRANSCRIPT');

-- CreateEnum
CREATE TYPE "CoverageStatus" AS ENUM ('PRESENT', 'NOT_RETURNED', 'UNAVAILABLE', 'NOT_APPLICABLE', 'NOT_REQUESTED', 'STALE', 'ERROR', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RetentionClass" AS ENUM ('API_METADATA', 'API_STATISTICS', 'AUTHORIZED_DATA', 'USER_CONTENT', 'FIXTURE');

-- CreateEnum
CREATE TYPE "HistoryState" AS ENUM ('NOT_STARTED', 'INITIAL_WINDOW_COLLECTED', 'BACKFILL_IN_PROGRESS', 'PAUSED_AWAITING_APPROVAL', 'COMPLETE_TO_SOURCE_LIMIT', 'FAILED_RETRYABLE', 'SOURCE_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('USER', 'CLAUDE', 'SYSTEM', 'CLI');

-- CreateEnum
CREATE TYPE "ExpansionKind" AS ENUM ('ADD_CHANNELS', 'DISCOVER_CHANNELS', 'BACKFILL_HISTORY', 'SYNC_UPLOADS', 'REFRESH_METADATA');

-- DropIndex (one transcript per video → many, keyed by source/language/owner)
DROP INDEX "Transcript_videoId_key";

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "defaultLanguage" TEXT,
ADD COLUMN     "isLinked" BOOLEAN,
ADD COLUMN     "localizations" JSONB,
ADD COLUMN     "madeForKids" BOOLEAN,
ADD COLUMN     "privacyStatus" TEXT,
ADD COLUMN     "thumbnails" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "topicIds" TEXT[],
ADD COLUMN     "trailerVideoId" TEXT;

-- AlterTable
ALTER TABLE "IngestionRun" ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "proposalId" TEXT,
ADD COLUMN     "scopeHash" TEXT;

-- AlterTable
ALTER TABLE "Transcript" ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "ownerKey" TEXT,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "providerTrackId" TEXT,
ADD COLUMN     "trackKind" "TranscriptKind",
ADD COLUMN     "updatedAt" TIMESTAMP(3),
ADD COLUMN     "visibility" "TranscriptVisibility" NOT NULL DEFAULT 'PRIVATE';

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "captionFlag" BOOLEAN,
ADD COLUMN     "channelTitle" TEXT,
ADD COLUMN     "contentRating" JSONB,
ADD COLUMN     "defaultAudioLanguage" TEXT,
ADD COLUMN     "definition" TEXT,
ADD COLUMN     "dimension" TEXT,
ADD COLUMN     "embeddable" BOOLEAN,
ADD COLUMN     "license" TEXT,
ADD COLUMN     "licensedContent" BOOLEAN,
ADD COLUMN     "liveActualEndAt" TIMESTAMP(3),
ADD COLUMN     "liveActualStartAt" TIMESTAMP(3),
ADD COLUMN     "liveBroadcastContent" TEXT,
ADD COLUMN     "liveScheduledStartAt" TIMESTAMP(3),
ADD COLUMN     "localizations" JSONB,
ADD COLUMN     "madeForKids" BOOLEAN,
ADD COLUMN     "privacyStatus" TEXT,
ADD COLUMN     "projection" TEXT,
ADD COLUMN     "publicStatsViewable" BOOLEAN,
ADD COLUMN     "regionRestriction" JSONB,
ADD COLUMN     "thumbnails" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "topicCategories" TEXT[],
ADD COLUMN     "transcriptStatus" "TranscriptStatus" NOT NULL DEFAULT 'NOT_CHECKED',
ADD COLUMN     "uploadStatus" TEXT;

-- AlterTable
ALTER TABLE "VideoTopic" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "extractor" TEXT;

-- AlterTable
ALTER TABLE "YouTubeConnection" ADD COLUMN     "lastRefreshError" TEXT,
ADD COLUMN     "lastValidatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FieldCoverage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT,
    "videoId" TEXT,
    "group" "CoverageGroup" NOT NULL,
    "status" "CoverageStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "details" JSONB,
    "retentionClass" "RetentionClass" NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "retentionDeadline" TIMESTAMP(3),
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadHistory" (
    "channelId" TEXT NOT NULL,
    "state" "HistoryState" NOT NULL DEFAULT 'NOT_STARTED',
    "nextPageToken" TEXT,
    "pageOffset" INTEGER NOT NULL DEFAULT 0,
    "pagesScanned" INTEGER NOT NULL DEFAULT 0,
    "itemsSeen" INTEGER NOT NULL DEFAULT 0,
    "videosCollected" INTEGER NOT NULL DEFAULT 0,
    "unavailableCount" INTEGER NOT NULL DEFAULT 0,
    "oldestPublishedAt" TIMESTAMP(3),
    "newestPublishedAt" TIMESTAMP(3),
    "totalResults" INTEGER,
    "lastPageAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastProposalId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadHistory_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "ExpansionProposal" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "source" "ProposalSource" NOT NULL,
    "kind" "ExpansionKind" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetIds" TEXT[],
    "scope" JSONB NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "coverageGap" TEXT,
    "uncertainty" TEXT,
    "estimatedChannels" INTEGER NOT NULL,
    "estimatedVideos" INTEGER NOT NULL,
    "estimatedQuota" INTEGER NOT NULL,
    "estimatedSearchCalls" INTEGER NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "executionDeadline" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "jobIds" TEXT[],
    "doneJobIds" TEXT[],
    "failedJobIds" TEXT[],
    "actualResults" JSONB NOT NULL DEFAULT '{}',
    "actualQuota" INTEGER NOT NULL DEFAULT 0,
    "actualSearchCalls" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpansionProposal_pkey" PRIMARY KEY ("id")
);

-- ── Data migration: transcripts (no rows are discarded) ─────────────────────
-- Fixture transcripts are the shared demo corpus.
UPDATE "Transcript" SET "visibility" = 'CORPUS', "ownerKey" = 'corpus', "trackKind" = 'FIXTURE' WHERE "source" = 'FIXTURE';
-- User uploads belong to the uploader (if that user still exists); orphans stay PRIVATE and unreadable.
UPDATE "Transcript" t SET "visibility" = 'PRIVATE', "trackKind" = 'UPLOADED',
  "ownerUserId" = CASE WHEN EXISTS (SELECT 1 FROM "user" u WHERE u.id = t."uploadedById") THEN t."uploadedById" END
WHERE t."source" = 'USER_UPLOAD';
-- Owner captions belong to the user whose YouTube connection owns the channel.
UPDATE "Transcript" t SET "visibility" = 'PRIVATE',
  "trackKind" = CASE WHEN t."isAutoGenerated" THEN 'ASR'::"TranscriptKind" ELSE 'MANUAL'::"TranscriptKind" END,
  "ownerUserId" = yc."userId", "connectionId" = yc.id
FROM "Video" v JOIN "Channel" c ON c.id = v."channelId" JOIN "YouTubeConnection" yc ON c."youtubeId" = ANY (yc."channelIds")
WHERE t."videoId" = v.id AND t."source" = 'OWNER_CAPTIONS';
UPDATE "Transcript" SET "trackKind" = CASE WHEN "isAutoGenerated" THEN 'ASR'::"TranscriptKind" ELSE 'MANUAL'::"TranscriptKind" END WHERE "trackKind" IS NULL;
UPDATE "Transcript" SET "ownerKey" = coalesce("ownerUserId", 'orphan:' || id) WHERE "ownerKey" IS NULL;
UPDATE "Transcript" SET "updatedAt" = "fetchedAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Transcript" ALTER COLUMN "ownerKey" SET NOT NULL, ALTER COLUMN "trackKind" SET NOT NULL, ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "Transcript" DROP COLUMN "uploadedById";
-- hasTranscript now means "a CORPUS-visible transcript exists".
UPDATE "Video" v SET "hasTranscript" = EXISTS (SELECT 1 FROM "Transcript" t WHERE t."videoId" = v.id AND t."visibility" = 'CORPUS');
UPDATE "Video" SET "transcriptStatus" = 'AVAILABLE' WHERE "hasTranscript";

-- ── Data migration: upload history checkpoints ─────────────────────────────
INSERT INTO "UploadHistory" ("channelId", "state", "nextPageToken", "itemsSeen", "videosCollected", "oldestPublishedAt", "newestPublishedAt", "updatedAt")
SELECT c.id,
  CASE WHEN c."backfillPageToken" IS NOT NULL THEN 'INITIAL_WINDOW_COLLECTED'::"HistoryState" ELSE 'COMPLETE_TO_SOURCE_LIMIT'::"HistoryState" END,
  c."backfillPageToken", count(v.id)::int, count(v.id)::int, min(v."publishedAt"), max(v."publishedAt"), now()
FROM "Channel" c LEFT JOIN "Video" v ON v."channelId" = c.id
WHERE c."uploadsPlaylistId" IS NOT NULL
GROUP BY c.id;
ALTER TABLE "Channel" DROP COLUMN "backfillPageToken";

-- ── Data migration: thumbnails + coverage for already-collected rows ───────
UPDATE "Channel" SET "thumbnails" = jsonb_build_array(jsonb_build_object('variant', 'legacy', 'url', "thumbnailUrl")) WHERE "thumbnailUrl" IS NOT NULL;
UPDATE "Video" SET "thumbnails" = jsonb_build_array(jsonb_build_object('variant', 'legacy', 'url', "thumbnailUrl")) WHERE "thumbnailUrl" IS NOT NULL;

-- CreateIndex
CREATE INDEX "FieldCoverage_group_status_idx" ON "FieldCoverage"("group", "status");

-- CreateIndex
CREATE INDEX "FieldCoverage_retentionDeadline_idx" ON "FieldCoverage"("retentionDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "FieldCoverage_channelId_group_key" ON "FieldCoverage"("channelId", "group");

-- CreateIndex
CREATE UNIQUE INDEX "FieldCoverage_videoId_group_key" ON "FieldCoverage"("videoId", "group");

-- CreateIndex
CREATE INDEX "ExpansionProposal_status_createdAt_idx" ON "ExpansionProposal"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExpansionProposal_createdByUserId_status_idx" ON "ExpansionProposal"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX "ExpansionProposal_kind_status_idx" ON "ExpansionProposal"("kind", "status");

-- CreateIndex
CREATE INDEX "IngestionRun_proposalId_idx" ON "IngestionRun"("proposalId");

-- CreateIndex
CREATE INDEX "Transcript_videoId_visibility_idx" ON "Transcript"("videoId", "visibility");

-- CreateIndex
CREATE INDEX "Transcript_ownerUserId_idx" ON "Transcript"("ownerUserId");

-- CreateIndex
CREATE INDEX "Transcript_connectionId_idx" ON "Transcript"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_videoId_source_language_ownerKey_key" ON "Transcript"("videoId", "source", "language", "ownerKey");

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "YouTubeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldCoverage" ADD CONSTRAINT "FieldCoverage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldCoverage" ADD CONSTRAINT "FieldCoverage_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadHistory" ADD CONSTRAINT "UploadHistory_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionProposal" ADD CONSTRAINT "ExpansionProposal_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionProposal" ADD CONSTRAINT "ExpansionProposal_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Coverage rows for data collected before field-level tracking existed. Freshness = lastRefreshedAt (the time the
-- record was last fetched); "legacy" details flag that variants/sub-fields were not recorded at the time.
INSERT INTO "FieldCoverage" (id, "channelId", "group", status, source, reason, details, "retentionClass", "lastAttemptAt", "lastSuccessAt", "retentionDeadline", "updatedAt")
SELECT 'cov_' || c.id || '_' || g.grp, c.id, g.grp::"CoverageGroup",
  CASE WHEN g.grp = 'THUMBNAILS' AND c."thumbnailUrl" IS NULL THEN 'NOT_RETURNED'::"CoverageStatus"
       WHEN g.grp = 'STATISTICS' AND c."hiddenSubscriberCount" THEN 'PRESENT'::"CoverageStatus"
       ELSE 'PRESENT'::"CoverageStatus" END,
  'youtube:channels.list', 'migrated', '{"legacy": true}'::jsonb,
  CASE WHEN g.grp = 'STATISTICS' THEN 'API_STATISTICS'::"RetentionClass" ELSE 'API_METADATA'::"RetentionClass" END,
  coalesce(c."lastRefreshedAt", c."createdAt"), coalesce(c."lastRefreshedAt", c."createdAt"),
  coalesce(c."lastRefreshedAt", c."createdAt") + interval '30 days', now()
FROM "Channel" c CROSS JOIN (VALUES ('IDENTITY'), ('TEXT'), ('CHANNEL_PROFILE'), ('THUMBNAILS'), ('STATISTICS')) AS g(grp);

INSERT INTO "FieldCoverage" (id, "videoId", "group", status, source, reason, details, "retentionClass", "lastAttemptAt", "lastSuccessAt", "retentionDeadline", "updatedAt")
SELECT 'cov_' || v.id || '_' || g.grp, v.id, g.grp::"CoverageGroup",
  CASE WHEN g.grp = 'THUMBNAILS' AND v."thumbnailUrl" IS NULL THEN 'NOT_RETURNED'::"CoverageStatus"
       WHEN g.grp = 'STATISTICS' AND v."viewCount" IS NULL THEN 'NOT_RETURNED'::"CoverageStatus"
       ELSE 'PRESENT'::"CoverageStatus" END,
  'youtube:videos.list', 'migrated', '{"legacy": true}'::jsonb,
  CASE WHEN g.grp = 'STATISTICS' THEN 'API_STATISTICS'::"RetentionClass" ELSE 'API_METADATA'::"RetentionClass" END,
  coalesce(v."lastRefreshedAt", v."createdAt"), coalesce(v."lastRefreshedAt", v."createdAt"),
  coalesce(v."lastRefreshedAt", v."createdAt") + interval '30 days', now()
FROM "Video" v CROSS JOIN (VALUES ('IDENTITY'), ('TEXT'), ('PUBLICATION'), ('THUMBNAILS'), ('STATISTICS')) AS g(grp);

INSERT INTO "FieldCoverage" (id, "videoId", "group", status, source, reason, "retentionClass", "lastAttemptAt", "lastSuccessAt", "updatedAt")
SELECT 'cov_' || v.id || '_TRANSCRIPT', v.id, 'TRANSCRIPT',
  CASE WHEN v."hasTranscript" THEN 'PRESENT'::"CoverageStatus" ELSE 'NOT_REQUESTED'::"CoverageStatus" END,
  CASE WHEN v."hasTranscript" THEN 'transcript:FIXTURE' ELSE 'none' END, 'migrated', 'FIXTURE',
  v."createdAt", CASE WHEN v."hasTranscript" THEN v."createdAt" END, now()
FROM "Video" v;
