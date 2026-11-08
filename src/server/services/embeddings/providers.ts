import { createHash } from "node:crypto";
import path from "node:path";
import { env } from "@/server/env";
import { log } from "@/server/logger";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/** transformers.js all-MiniLM-L6-v2 (384-d, mean-pooled, normalized). Lazy singleton; zero API keys. */
export class LocalProvider implements EmbeddingProvider {
  readonly name = `local:${env.EMBEDDING_MODEL}`;
  readonly dimensions = 384;
  private extractor: Promise<Extractor> | null = null;

  private load(): Promise<Extractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const t0 = Date.now();
        const tf = await import("@huggingface/transformers");
        tf.env.cacheDir = path.join(process.cwd(), ".cache", "models");
        const ex = (await tf.pipeline("feature-extraction", env.EMBEDDING_MODEL, { dtype: "q8" })) as unknown as Extractor;
        log().info({ model: env.EMBEDDING_MODEL, ms: Date.now() - t0 }, "embedding model loaded");
        return ex;
      })();
      this.extractor.catch(() => (this.extractor = null));
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const ex = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32).map((t) => t.slice(0, 2000) || " ");
      out.push(...(await ex(batch, { pooling: "mean", normalize: true })).tolist());
    }
    return out;
  }
}

/**
 * Deterministic feature-hashing embedding (unigrams + bigrams, signed buckets, L2-normalized).
 * Offline/CI fallback only — lexical, not semantic.
 */
export class HashProvider implements EmbeddingProvider {
  readonly name = "hash";
  constructor(readonly dimensions = env.EMBEDDING_DIM) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      const toks = (t.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
      const feats = [...toks, ...toks.slice(1).map((w, i) => `${toks[i]}_${w}`)];
      for (const f of feats) {
        const h = createHash("md5").update(f).digest();
        const idx = h.readUInt32LE(0) % this.dimensions;
        v[idx]! += h[4]! & 1 ? 1 : -1;
      }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
  }
}

/** OpenAI-compatible `/embeddings` endpoint. */
export class RemoteProvider implements EmbeddingProvider {
  readonly name = "remote";
  readonly dimensions = env.EMBEDDING_DIM;
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(env.EMBEDDING_REMOTE_URL!, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.EMBEDDING_REMOTE_API_KEY ? { authorization: `Bearer ${env.EMBEDDING_REMOTE_API_KEY}` } : {}) },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: texts, dimensions: env.EMBEDDING_DIM }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`embedding provider ${res.status}`);
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

let provider: EmbeddingProvider | null = null;
export function getProvider(): EmbeddingProvider {
  if (!provider) {
    provider = env.EMBEDDING_PROVIDER === "local" ? new LocalProvider() : env.EMBEDDING_PROVIDER === "remote" ? new RemoteProvider() : new HashProvider();
    if (provider.dimensions !== env.EMBEDDING_DIM) {
      throw new Error(`Embedding provider ${provider.name} has ${provider.dimensions} dims but EMBEDDING_DIM=${env.EMBEDDING_DIM}. Changing dimensions needs a migration + pnpm embeddings:reindex.`);
    }
  }
  return provider;
}
