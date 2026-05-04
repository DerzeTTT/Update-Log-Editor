import { z } from "zod";

export const logItemSchema = z.object({
  text: z.string(),
  children: z.array(z.string()).default([]),
  footers: z.array(z.string()).default([])
});

export const logSectionSchema = z.object({
  title: z.string(),
  items: z.array(logItemSchema)
});

export const updateLogSchema = z.object({
  title: z.string(),
  sections: z.array(logSectionSchema),
  footer: z.string().default("")
});

export const aiEditResponseSchema = z.object({
  summary: z.string(),
  updatedLog: updateLogSchema
});

export const settingsSchema = z.object({
  selectedModelMode: z.enum(["default", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark", "custom"]).default("gpt-5.4"),
  customModel: z.string().default(""),
  characterLimitMode: z.enum(["normal", "nitro", "webhook", "custom"]).default("normal"),
  nitroDefault: z.boolean().default(false),
  customLimit: z.number().int().min(100).max(10000).default(2000),
  defaultFooter: z.string().default("-# ||@everyone||"),
  theme: z.enum(["dark", "midnight"]).default("dark"),
  autosaveIntervalMs: z.number().int().min(1000).max(60000).default(2500),
  continuationHeaders: z.boolean().default(false)
});

export type LogItem = z.infer<typeof logItemSchema>;
export type LogSection = z.infer<typeof logSectionSchema>;
export type UpdateLog = z.infer<typeof updateLogSchema>;
export type AiEditResponse = z.infer<typeof aiEditResponseSchema>;
export type AppSettings = z.infer<typeof settingsSchema>;

export type DraftRecord = {
  id: string;
  name: string;
  rawMarkdown: string;
  structured: UpdateLog;
  filePath: string;
  createdAt: string;
  updatedAt: string;
};

export type VersionRecord = {
  id: string;
  draftId: string;
  rawMarkdown: string;
  structured: UpdateLog;
  label: string;
  createdAt: string;
};

export type CodexIntakeEntry = {
  id: string;
  draftId: string;
  draftName: string;
  sectionTitle: string;
  bulletText: string;
  children: string[];
  source: string;
  createdAt: string;
};

export type AiHistoryRecord = {
  id: string;
  draftId: string;
  instruction: string;
  model: string;
  summary: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  status: "proposed" | "accepted" | "rejected";
  createdAt: string;
};

export type SplitMode = "normal" | "nitro" | "webhook" | "custom";

export type SplitOptions = {
  mode: SplitMode;
  customLimit?: number;
  continuationHeaders?: boolean;
  title?: string;
  footer?: string;
};

export type SplitResult = {
  chunks: string[];
  limit: number;
  totalCharacters: number;
  warnings: string[];
};
