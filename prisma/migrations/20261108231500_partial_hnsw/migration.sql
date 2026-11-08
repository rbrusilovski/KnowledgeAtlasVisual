-- Hand-written: recreate HNSW indexes as partial indexes.
-- Prisma cannot express HNSW in schema.prisma and would otherwise emit DROP INDEX for them on every
-- `migrate dev`. Prisma ignores partial indexes, so these survive. KNN queries MUST include
-- `WHERE <col> IS NOT NULL` so the planner can use them (see src/server/db/vector.ts).
DROP INDEX IF EXISTS "Channel_embedding_hnsw";
DROP INDEX IF EXISTS "Video_embedding_hnsw";
DROP INDEX IF EXISTS "TranscriptChunk_embedding_hnsw";
DROP INDEX IF EXISTS "Topic_embedding_hnsw";
DROP INDEX IF EXISTS "Niche_centroid_hnsw";

CREATE INDEX "Channel_embedding_hnsw" ON "Channel" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;
CREATE INDEX "Video_embedding_hnsw" ON "Video" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;
CREATE INDEX "TranscriptChunk_embedding_hnsw" ON "TranscriptChunk" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;
CREATE INDEX "Topic_embedding_hnsw" ON "Topic" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;
CREATE INDEX "Niche_centroid_hnsw" ON "Niche" USING hnsw ("centroid" vector_cosine_ops) WHERE "centroid" IS NOT NULL;
