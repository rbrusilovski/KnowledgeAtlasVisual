/** OpenAPI 3.1 document generated from the shared Zod contracts via Zod 4's native z.toJSONSchema. */
import { z, type ZodType } from "zod";
import * as C from "@/shared/contracts/channels";
import * as G from "@/shared/contracts/graph";
import * as S from "@/shared/contracts/search";
import * as W from "@/shared/contracts/workspaces";
import * as D from "@/shared/contracts/discover";
import { ErrorEnvelope } from "@/shared/contracts/common";

type Op = { summary: string; auth?: boolean; query?: ZodType; body?: ZodType; params?: string[] };

const OPS: Record<string, Partial<Record<"get" | "post" | "patch" | "put" | "delete", Op>>> = {
  "/api/discover/channels": { post: { summary: "Search YouTube for channels (1 search.list call)", auth: true, body: D.DiscoverBody } },
  "/api/discover/niche/{nicheId}": { post: { summary: "Run a subniche's discovery queries (requires confirm)", auth: true, body: D.DiscoverNicheBody, params: ["nicheId"] } },
  "/api/channels": { get: { summary: "List/filter channels", query: C.ChannelListQuery }, post: { summary: "Add a channel by URL/handle/ID", auth: true, body: C.AddChannelBody } },
  "/api/channels/{id}": { get: { summary: "Channel detail", params: ["id"] } },
  "/api/channels/{id}/videos": { get: { summary: "Search/filter within a channel", query: C.ChannelVideosQuery, params: ["id"] } },
  "/api/channels/{id}/related": { get: { summary: "Ranked related creators with reasons", params: ["id"] } },
  "/api/channels/{id}/sync": { post: { summary: "Manual sync", auth: true, body: C.SyncChannelBody, params: ["id"] } },
  "/api/channels/{id}/niches": { patch: { summary: "Manual niche override", auth: true, body: C.NicheOverrideBody, params: ["id"] } },
  "/api/videos/{id}": { get: { summary: "Video detail", params: ["id"] } },
  "/api/videos/{id}/transcript": { get: { summary: "Transcript chunks (+ ?q= search)", params: ["id"], query: z.object({ q: z.string().optional() }) }, post: { summary: "Upload VTT/SRT/TXT", auth: true, body: D.TranscriptUploadBody, params: ["id"] } },
  "/api/videos/{id}/extract": { post: { summary: "AI extraction (if enabled)", auth: true, params: ["id"] } },
  "/api/niches": { get: { summary: "Niche tree with counts" } },
  "/api/niches/{id}": { get: { summary: "Niche detail: top channels/topics", params: ["id"] } },
  "/api/topics": { get: { summary: "List/search topics" } },
  "/api/topics/{id}": { get: { summary: "Topic detail", params: ["id"] } },
  "/api/search": { get: { summary: "Hybrid/keyword/semantic search", query: S.SearchQuery } },
  "/api/search/suggest": { get: { summary: "Autocomplete", query: S.SuggestQuery } },
  "/api/graph": { get: { summary: "Subgraph (global/local)", query: G.GraphQuery } },
  "/api/graph/nodes/{nodeId}/neighbors": { get: { summary: "Expand a node", query: G.NeighborsQuery, params: ["nodeId"] } },
  "/api/graph/delta": { get: { summary: "Changes since a graph version", query: G.DeltaQuery } },
  "/api/graph/path": { get: { summary: "How are two nodes connected?", query: G.PathQuery } },
  "/api/workspaces": { get: { summary: "List workspaces", auth: true }, post: { summary: "Create workspace", auth: true, body: W.WorkspaceBody } },
  "/api/workspaces/{id}": { get: { summary: "Workspace", auth: true, params: ["id"] }, patch: { summary: "Update workspace", auth: true, body: W.WorkspacePatch, params: ["id"] }, delete: { summary: "Delete workspace", auth: true, params: ["id"] } },
  "/api/workspaces/{id}/collections": { get: { summary: "Collections", auth: true, params: ["id"] }, post: { summary: "Create collection", auth: true, body: W.CollectionBody, params: ["id"] } },
  "/api/collections/{id}": { get: { summary: "Collection with items", auth: true, params: ["id"] }, patch: { summary: "Update collection", auth: true, body: W.CollectionPatch, params: ["id"] }, delete: { summary: "Delete collection", auth: true, params: ["id"] } },
  "/api/collections/{id}/items": { post: { summary: "Bulk add items", auth: true, body: W.AddItemsBody, params: ["id"] }, delete: { summary: "Bulk remove items", auth: true, body: W.RemoveItemsBody, params: ["id"] } },
  "/api/collections/{id}/items/{itemId}": { patch: { summary: "Edit item note/tags", auth: true, body: W.ItemPatch, params: ["id", "itemId"] } },
  "/api/collections/{id}/export": { get: { summary: "Export collection", auth: true, query: W.ExportQuery, params: ["id"] } },
  "/api/workspaces/{id}/views": { get: { summary: "Saved views", auth: true, params: ["id"] }, post: { summary: "Save view", auth: true, body: W.ViewBody, params: ["id"] } },
  "/api/views/{id}": { patch: { summary: "Update view", auth: true, body: W.ViewPatch, params: ["id"] }, delete: { summary: "Delete view", auth: true, params: ["id"] } },
  "/api/workspaces/{id}/layout": { get: { summary: "Pinned layout", auth: true, params: ["id"] }, put: { summary: "Batch upsert pinned positions", auth: true, body: W.LayoutBody, params: ["id"] } },
  "/api/events": { get: { summary: "Server-Sent Events stream" } },
  "/api/jobs/{id}": { get: { summary: "Job status", params: ["id"] } },
  "/api/quota": { get: { summary: "Quota usage per bucket" } },
  "/api/health": { get: { summary: "Health checks" } },
  "/api/me": { get: { summary: "Current user", auth: true }, delete: { summary: "Delete account + data", auth: true } },
  "/api/me/export": { get: { summary: "Export all personal data", auth: true } },
};

const schema = (t: ZodType, io: "input" | "output" = "input") => z.toJSONSchema(t, { io, unrepresentable: "any" });

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(OPS)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(ops)) {
      const parameters: unknown[] = (op.params ?? []).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
      if (op.query) {
        const js = schema(op.query) as { properties?: Record<string, unknown>; required?: string[] };
        for (const [name, s] of Object.entries(js.properties ?? {})) parameters.push({ name, in: "query", required: js.required?.includes(name) ?? false, schema: s });
      }
      paths[path][method] = {
        summary: op.summary,
        ...(op.auth ? { security: [{ session: [] }] } : {}),
        parameters,
        ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(op.body) } } } } : {}),
        responses: {
          "200": { description: "Success envelope `{ data, meta? }`" },
          default: { description: "Error envelope", content: { "application/json": { schema: schema(ErrorEnvelope, "output") } } },
        },
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Atlas API", version: "1.0.0", description: "YouTube knowledge atlas. Data from the YouTube Data API v3 (or the fictional demo dataset in fixture mode)." },
    components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" } } },
    paths,
  };
}
