import { z } from "zod";
import { NodeId } from "./common";

const name = z.string().trim().min(1).max(80);
const desc = z.string().trim().max(500);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const icon = z.string().regex(/^[a-z0-9-]{1,32}$/);

export const WorkspaceBody = z.object({ name, description: desc.optional() });
export const WorkspacePatch = z.object({ name: name.optional(), description: desc.nullable().optional() });

export const CollectionBody = z.object({ name, description: desc.optional(), color: color.optional(), icon: icon.optional() });
export const CollectionPatch = z.object({ name: name.optional(), description: desc.nullable().optional(), color: color.optional(), icon: icon.optional(), sortOrder: z.number().int().min(0).max(10_000).optional() });

const tag = z.string().trim().min(1).max(40);
export const AddItemsBody = z.object({
  items: z.array(z.object({ nodeId: NodeId, note: z.string().max(5000).optional(), tags: z.array(tag).max(20).optional() })).min(1).max(500),
});
export const RemoveItemsBody = z.object({ nodeIds: z.array(NodeId).max(500).optional(), itemIds: z.array(z.string().max(100)).max(500).optional() }).refine((v) => v.nodeIds?.length || v.itemIds?.length, "nodeIds or itemIds required");
export const ItemPatch = z.object({ note: z.string().max(5000).nullable().optional(), tags: z.array(tag).max(20).optional() });

/** Saved view state: filters, focus, mode, camera. Validated so arbitrary blobs can't be stored. */
export const ViewState = z.object({
  mode: z.enum(["global", "local"]).default("global"),
  focus: NodeId.nullable().optional(),
  depth: z.number().int().min(1).max(3).optional(),
  filters: z.record(z.string(), z.unknown()).default({}),
  colorBy: z.enum(["type", "niche", "community"]).optional(),
  sizeBy: z.enum(["subscribers", "views", "degree"]).optional(),
  labels: z.enum(["auto", "all", "none"]).optional(),
  camera: z.object({ x: z.number(), y: z.number(), ratio: z.number().positive(), angle: z.number().default(0) }).optional(),
  hidden: z.array(NodeId).max(2000).optional(),
});
export type ViewState = z.infer<typeof ViewState>;
export const ViewBody = z.object({ name, state: ViewState });
export const ViewPatch = z.object({ name: name.optional(), state: ViewState.optional() });

export const LayoutBody = z.object({
  positions: z.array(z.object({ nodeId: NodeId, x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6), pinned: z.boolean().default(true) })).max(5000),
  remove: z.array(NodeId).max(5000).optional(),
});

export const ExportQuery = z.object({ format: z.enum(["json", "csv"]).default("json") });

export const SettingsPatch = z.object({ name: name.optional(), reducedMotion: z.boolean().optional(), defaultLayout: z.enum(["global", "local"]).optional() });
