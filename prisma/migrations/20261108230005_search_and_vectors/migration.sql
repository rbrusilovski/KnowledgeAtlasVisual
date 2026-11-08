-- Hand-written: full-text search vectors (trigger-maintained), vector indexes, graph version sequence.
-- Prisma ignores triggers, functions, sequences and these raw indexes (declared Unsupported in schema).

-- ── Channel ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION atlas_channel_tsv() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."handle", '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(NEW."keywords", '{}'), ' ')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW."description", ''), 5000)), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER channel_tsv BEFORE INSERT OR UPDATE OF "title", "handle", "keywords", "description"
  ON "Channel" FOR EACH ROW EXECUTE FUNCTION atlas_channel_tsv();

-- ── Video ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION atlas_video_tsv() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(NEW."tags", '{}'), ' ')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW."description", ''), 5000)), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER video_tsv BEFORE INSERT OR UPDATE OF "title", "tags", "description"
  ON "Video" FOR EACH ROW EXECUTE FUNCTION atlas_video_tsv();

-- ── TranscriptChunk ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION atlas_chunk_tsv() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" := to_tsvector('english', coalesce(NEW."text", ''));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER chunk_tsv BEFORE INSERT OR UPDATE OF "text"
  ON "TranscriptChunk" FOR EACH ROW EXECUTE FUNCTION atlas_chunk_tsv();

-- ── Topic ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION atlas_topic_tsv() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."label", '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(NEW."aliases", '{}'), ' ')), 'B');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER topic_tsv BEFORE INSERT OR UPDATE OF "label", "aliases"
  ON "Topic" FOR EACH ROW EXECUTE FUNCTION atlas_topic_tsv();

-- ── GIN indexes on search vectors ───────────────────────────────────────
CREATE INDEX "Channel_searchVector_idx" ON "Channel" USING GIN ("searchVector");
CREATE INDEX "Video_searchVector_idx" ON "Video" USING GIN ("searchVector");
CREATE INDEX "TranscriptChunk_searchVector_idx" ON "TranscriptChunk" USING GIN ("searchVector");
CREATE INDEX "Topic_searchVector_idx" ON "Topic" USING GIN ("searchVector");

-- ── HNSW indexes on embeddings (cosine) ─────────────────────────────────
CREATE INDEX "Channel_embedding_hnsw" ON "Channel" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "Video_embedding_hnsw" ON "Video" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "TranscriptChunk_embedding_hnsw" ON "TranscriptChunk" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "Topic_embedding_hnsw" ON "Topic" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "Niche_centroid_hnsw" ON "Niche" USING hnsw ("centroid" vector_cosine_ops);

-- ── Graph version sequence ──────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS graph_version_seq START 1;
