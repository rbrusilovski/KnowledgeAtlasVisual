import { z } from "zod";

export const DiscoverBody = z.object({
  query: z.string().trim().min(2).max(120),
  nicheId: z.string().max(100).optional(),
  regionCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  relevanceLanguage: z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/).optional(),
  maxResults: z.number().int().min(1).max(50).default(25),
});

export const DiscoverNicheBody = z.object({
  confirm: z.boolean().optional(),
  regionCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  maxResults: z.number().int().min(1).max(50).default(15),
});

export const TranscriptUploadBody = z.object({
  text: z.string().min(1).max(2_000_000),
  filename: z.string().max(200).optional(),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
});
