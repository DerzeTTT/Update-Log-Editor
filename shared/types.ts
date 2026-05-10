import { z } from "zod";

export const customEmojiSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_+-]+$/),
  emoji: z.string().trim().min(1).max(128)
});

export const genericEmojiCatalog = [
  { name: "Star", emoji: "\u2b50" },
  { name: "Heart", emoji: "\u2764\ufe0f" },
  { name: "Fire", emoji: "\ud83d\udd25" },
  { name: "Sparkles", emoji: "\u2728" },
  { name: "Check", emoji: "\u2705" },
  { name: "Cross", emoji: "\u274c" },
  { name: "Warning", emoji: "\u26a0\ufe0f" },
  { name: "Info", emoji: "\u2139\ufe0f" },
  { name: "Bug", emoji: "\ud83d\udc1b" },
  { name: "Wrench", emoji: "\ud83d\udd27" },
  { name: "Hammer", emoji: "\ud83d\udd28" },
  { name: "Gear", emoji: "\u2699\ufe0f" },
  { name: "Sword", emoji: "\u2694\ufe0f" },
  { name: "Shield", emoji: "\ud83d\udee1\ufe0f" },
  { name: "Trophy", emoji: "\ud83c\udfc6" },
  { name: "Crown", emoji: "\ud83d\udc51" },
  { name: "Gift", emoji: "\ud83c\udf81" },
  { name: "Rocket", emoji: "\ud83d\ude80" },
  { name: "Zap", emoji: "\u26a1" },
  { name: "Bell", emoji: "\ud83d\udd14" },
  { name: "Lock", emoji: "\ud83d\udd12" },
  { name: "Unlock", emoji: "\ud83d\udd13" },
  { name: "Eyes", emoji: "\ud83d\udc40" },
  { name: "Wave", emoji: "\ud83d\udc4b" },
  { name: "ThumbsUp", emoji: "\ud83d\udc4d" },
  { name: "ThumbsDown", emoji: "\ud83d\udc4e" },
  { name: "Up", emoji: "\u2b06\ufe0f" },
  { name: "Down", emoji: "\u2b07\ufe0f" },
  { name: "Left", emoji: "\u2b05\ufe0f" },
  { name: "Right", emoji: "\u27a1\ufe0f" },
  { name: "Plus", emoji: "\u2795" },
  { name: "Minus", emoji: "\u2796" },
  { name: "New", emoji: "\ud83c\udd95" },
  { name: "Hot", emoji: "\ud83d\udd25" },
  { name: "Cool", emoji: "\ud83d\ude0e" },
  { name: "Happy", emoji: "\ud83d\ude04" },
  { name: "Sad", emoji: "\ud83d\ude22" },
  { name: "Angry", emoji: "\ud83d\ude20" },
  { name: "Skull", emoji: "\ud83d\udc80" },
  { name: "Clock", emoji: "\ud83d\udd52" },
  { name: "Calendar", emoji: "\ud83d\udcc5" },
  { name: "Pin", emoji: "\ud83d\udccc" },
  { name: "Link", emoji: "\ud83d\udd17" },
  { name: "Money", emoji: "\ud83d\udcb0" },
  { name: "Gem", emoji: "\ud83d\udc8e" },
  { name: "Boom", emoji: "\ud83d\udca5" },
  { name: "Snowflake", emoji: "\u2744\ufe0f" },
  { name: "Question", emoji: "\u2753" },
  { name: "Exclamation", emoji: "\u2757" }
] as const;

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
  continuationHeaders: z.boolean().default(false),
  customEmojis: z.array(customEmojiSchema).default([])
});

export type LogItem = z.infer<typeof logItemSchema>;
export type LogSection = z.infer<typeof logSectionSchema>;
export type UpdateLog = z.infer<typeof updateLogSchema>;
export type AiEditResponse = z.infer<typeof aiEditResponseSchema>;
export type AppSettings = z.infer<typeof settingsSchema>;
export type CustomEmoji = z.infer<typeof customEmojiSchema>;

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
