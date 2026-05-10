import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appendCodexIntake,
  createAutosaveVersion,
  createDraft,
  createVersion,
  deleteDraft,
  duplicateDraft,
  getDraft,
  getDraftBackupDir,
  getDraftLatestBackupPath,
  getDraftMarkdownPath,
  getVersion,
  getSettings,
  importDraftMarkdownFile,
  initDb,
  listAiHistory,
  listCodexIntakeForDay,
  listDraftBackups,
  listDraftSummaries,
  listVersionSummaries,
  recordAiHistory,
  retrieveDrafts,
  restoreVersion,
  restoreLatestDraftBackup,
  saveSettings,
  updateDraft
} from "./db";
import { parseUpdateLog, serializeUpdateLog } from "../shared/markdown";
import { splitDiscordMessages } from "../shared/splitter";
import { customEmojiSchema, settingsSchema, updateLogSchema } from "../shared/types";
import { getCodexStatus, runCodexEdit, runCodexPrompt, updateCodexCli, validateModelName } from "./codex";

const app = express();
const port = Number(process.env.PORT ?? 4317);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const customEmojiDir = join(rootDir, "data", "custom-emojis");
const launcherSessionId = process.env.UPDATE_LOG_LAUNCHER_SESSION ?? "";
const launcherCloseOnLastTab = process.env.UPDATE_LOG_CLOSE_ON_LAST_TAB === "1" && launcherSessionId.length > 0;
const launcherHeartbeatIntervalMs = 3000;
const launcherStaleTabMs = 15_000;
const launcherCloseGraceMs = 4500;
const allowedEmojiMimeTypes = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"]
]);
const launcherTabSchema = z.object({
  sessionId: z.string(),
  tabId: z.string().min(1).max(200)
});
const launcherTabs = new Map<string, { lastSeen: number }>();
let launcherSawTab = false;
let launcherShutdownTimer: ReturnType<typeof setTimeout> | null = null;

initDb();
mkdirSync(customEmojiDir, { recursive: true });

app.use(express.json({ limit: "8mb" }));
app.use("/api/custom-emojis", express.static(customEmojiDir));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function pruneLauncherTabs(now = Date.now()) {
  for (const [tabId, tab] of launcherTabs) {
    if (now - tab.lastSeen > launcherStaleTabMs) launcherTabs.delete(tabId);
  }
}

function cancelLauncherShutdown() {
  if (!launcherShutdownTimer) return;
  clearTimeout(launcherShutdownTimer);
  launcherShutdownTimer = null;
}

function scheduleLauncherShutdown(reason: string) {
  if (!launcherCloseOnLastTab || !launcherSawTab || launcherShutdownTimer) return;
  pruneLauncherTabs();
  if (launcherTabs.size > 0) return;
  console.log(`No launcher browser tabs remain (${reason}); shutting down in ${launcherCloseGraceMs}ms.`);
  launcherShutdownTimer = setTimeout(() => {
    launcherShutdownTimer = null;
    pruneLauncherTabs();
    if (launcherTabs.size > 0) return;
    console.log("Launcher browser tab closed; stopping API.");
    process.exit(0);
  }, launcherCloseGraceMs);
  launcherShutdownTimer.unref();
}

function recordLauncherTab(tabId: string) {
  launcherSawTab = true;
  launcherTabs.set(tabId, { lastSeen: Date.now() });
  cancelLauncherShutdown();
}

if (launcherCloseOnLastTab) {
  const staleTabInterval = setInterval(() => scheduleLauncherShutdown("stale heartbeat"), launcherHeartbeatIntervalMs);
  staleTabInterval.unref();
}

app.get("/api/launcher/session", (_req, res) => {
  res.json({
    closeOnLastTab: launcherCloseOnLastTab,
    sessionId: launcherCloseOnLastTab ? launcherSessionId : undefined,
    heartbeatIntervalMs: launcherHeartbeatIntervalMs
  });
});

app.post("/api/launcher/tabs/:event", (req, res) => {
  if (!launcherCloseOnLastTab) {
    res.status(204).send();
    return;
  }
  const event = z.enum(["open", "heartbeat", "close"]).parse(req.params.event);
  const body = launcherTabSchema.parse(req.body);
  if (body.sessionId !== launcherSessionId) {
    res.status(403).json({ error: "Invalid launcher session." });
    return;
  }
  if (event === "close") {
    launcherSawTab = true;
    launcherTabs.delete(body.tabId);
    scheduleLauncherShutdown("tab close");
    res.status(204).send();
    return;
  }
  recordLauncherTab(body.tabId);
  res.status(204).send();
});

app.get("/api/drafts", (_req, res) => {
  res.json({ drafts: listDraftSummaries() });
});

app.post("/api/drafts", (req, res) => {
  const body = z.object({
    name: z.string().min(1).default("Untitled Update"),
    rawMarkdown: z.string().default("## Untitled Update\n\n-# ||@everyone||")
  }).parse(req.body);
  res.status(201).json({ draft: createDraft(body.name, body.rawMarkdown) });
});

app.get("/api/drafts/:id", (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  res.json({ draft });
});

app.get("/api/drafts/:id/file", (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  res.json({ filePath: getDraftMarkdownPath(draft.id), draft });
});

app.post("/api/drafts/:id/import-file", (req, res) => {
  const draft = importDraftMarkdownFile(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  res.json({ draft });
});

app.put("/api/drafts/:id", (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    rawMarkdown: z.string(),
    structured: updateLogSchema.optional()
  }).parse(req.body);
  const structured = body.structured ?? parseUpdateLog(body.rawMarkdown).log;
  const draft = updateDraft(req.params.id, body.rawMarkdown, structured, body.name);
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  res.json({ draft });
});

app.post("/api/drafts/:id/emergency-save", (req, res) => {
  const existing = getDraft(req.params.id);
  if (!existing) return res.status(404).json({ error: "Draft not found." });
  const body = z.object({
    name: z.string().min(1).optional(),
    rawMarkdown: z.string(),
    structured: updateLogSchema.optional()
  }).parse(req.body);
  const structured = body.structured ?? parseUpdateLog(body.rawMarkdown).log;
  const draft = updateDraft(existing.id, body.rawMarkdown, structured, body.name) ?? existing;
  const version = createAutosaveVersion(draft, getSettings());
  res.json({ version: version ?? null, draft });
});

app.post("/api/drafts/:id/save-version", (req, res) => {
  const existing = getDraft(req.params.id);
  if (!existing) return res.status(404).json({ error: "Draft not found." });
  const body = z.object({
    label: z.string().default("Manual save"),
    autosave: z.boolean().default(false),
    name: z.string().min(1).optional(),
    rawMarkdown: z.string().optional(),
    structured: updateLogSchema.optional()
  }).parse(req.body);
  const rawMarkdown = body.rawMarkdown ?? existing.rawMarkdown;
  const structured = body.structured ?? parseUpdateLog(rawMarkdown).log;
  const draft = updateDraft(existing.id, rawMarkdown, structured, body.name) ?? existing;
  const version = body.autosave
    ? createAutosaveVersion(draft, getSettings())
    : createVersion(draft.id, draft.rawMarkdown, draft.structured, body.label);
  res.status(version ? 201 : 200).json({ version: version ?? null, draft });
});

app.get("/api/drafts/:id/backups", (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  res.json({
    backupDir: getDraftBackupDir(draft.id),
    latestBackupPath: getDraftLatestBackupPath(draft.id),
    backups: listDraftBackups(draft.id)
  });
});

app.post("/api/drafts/:id/backups/restore-latest", (req, res) => {
  const draft = restoreLatestDraftBackup(req.params.id);
  if (!draft) return res.status(404).json({ error: "Backup not found." });
  res.json({ draft });
});

app.post("/api/drafts/:id/duplicate", (req, res) => {
  const draft = duplicateDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  res.status(201).json({ draft });
});

app.delete("/api/drafts/:id", (req, res) => {
  if (!deleteDraft(req.params.id)) return res.status(404).json({ error: "Draft not found." });
  res.status(204).send();
});

app.get("/api/drafts/:id/versions", (req, res) => {
  res.json({ versions: listVersionSummaries(req.params.id) });
});

app.get("/api/versions/:id", (req, res) => {
  const version = getVersion(req.params.id);
  if (!version) return res.status(404).json({ error: "Version not found." });
  res.json({ version });
});

app.post("/api/versions/:id/restore", (req, res) => {
  const draft = restoreVersion(req.params.id);
  if (!draft) return res.status(404).json({ error: "Version not found." });
  res.json({ draft });
});

app.get("/api/drafts/:id/ai-history", (req, res) => {
  res.json({ history: listAiHistory(req.params.id) });
});

app.post("/api/tools/parse", (req, res) => {
  const body = z.object({ rawMarkdown: z.string() }).parse(req.body);
  res.json(parseUpdateLog(body.rawMarkdown));
});

app.post("/api/tools/serialize", (req, res) => {
  const body = z.object({ structured: updateLogSchema }).parse(req.body);
  res.json({ rawMarkdown: serializeUpdateLog(body.structured) });
});

app.post("/api/tools/split", (req, res) => {
  const body = z.object({
    rawMarkdown: z.string(),
    options: z.object({
      mode: z.enum(["normal", "nitro", "webhook", "custom"]),
      customLimit: z.number().optional(),
      continuationHeaders: z.boolean().optional(),
      title: z.string().optional(),
      footer: z.string().optional()
    })
  }).parse(req.body);
  res.json(splitDiscordMessages(body.rawMarkdown, body.options));
});

app.get("/api/settings", (_req, res) => {
  res.json({ settings: getSettings() });
});

app.put("/api/settings", (req, res) => {
  res.json({ settings: saveSettings(settingsSchema.parse(req.body)) });
});

app.post("/api/emojis/upload", (req, res) => {
  try {
    const body = z.object({
      name: customEmojiSchema.shape.name,
      mimeType: z.string(),
      dataUrl: z.string().max(7_500_000)
    }).parse(req.body);
    const extension = allowedEmojiMimeTypes.get(body.mimeType);
    if (!extension) {
      return res.status(400).json({ error: "Use a PNG, JPG, GIF, or WEBP image." });
    }
    const prefix = `data:${body.mimeType};base64,`;
    if (!body.dataUrl.startsWith(prefix)) {
      return res.status(400).json({ error: "Invalid emoji image upload." });
    }
    const imageBuffer = Buffer.from(body.dataUrl.slice(prefix.length), "base64");
    if (imageBuffer.length === 0 || imageBuffer.length > 2_000_000) {
      return res.status(400).json({ error: "Emoji image must be 2 MB or smaller." });
    }
    const fileName = `${body.name.toLowerCase()}-${randomUUID()}.${extension}`;
    writeFileSync(join(customEmojiDir, fileName), imageBuffer);
    res.status(201).json({
      emoji: {
        name: body.name,
        emoji: `/api/custom-emojis/${fileName}`
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Emoji upload failed.";
    res.status(400).json({ error: message.slice(0, 4000) });
  }
});

app.get("/api/codex/status", async (req, res) => {
  const settings = getSettings();
  const selected = settings.selectedModelMode === "custom" ? settings.customModel : settings.selectedModelMode;
  const query = z.object({
    full: z.coerce.boolean().default(false),
    force: z.coerce.boolean().default(false)
  }).parse(req.query);
  res.json(await getCodexStatus(selected, query));
});

app.get("/api/codex/drafts/retrieve", (req, res) => {
  const query = z.object({
    when: z.string().trim().optional(),
    q: z.string().trim().optional(),
    query: z.string().trim().optional(),
    draftId: z.string().trim().optional(),
    source: z.enum(["all", "current", "versions"]).default("all"),
    limit: z.coerce.number().int().min(1).max(50).default(10)
  }).parse(req.query);
  const result = retrieveDrafts({
    when: query.when,
    query: query.query ?? query.q,
    draftId: query.draftId,
    source: query.source,
    limit: query.limit
  });
  res.json({
    ...result,
    count: result.matches.length
  });
});

app.post("/api/codex/drafts/restore", (req, res) => {
  const body = z.object({
    versionId: z.string().min(1)
  }).parse(req.body);
  const draft = restoreVersion(body.versionId);
  if (!draft) return res.status(404).json({ error: "Version not found." });
  res.json({ draft });
});

app.post("/api/codex/update", async (_req, res) => {
  try {
    res.json(await updateCodexCli());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex update failed.";
    res.status(502).json({ error: message.slice(0, 4000) });
  }
});

function buildPromptWithDraftContext(input: { prompt: string; draft: ReturnType<typeof retrieveDrafts>["matches"][number] }) {
  return `You are helping with a local Roblox Discord update log in Update Log Editor.

Answer the user's request using the current draft context below. If the user asks for an edit, describe the edit or return the requested structured output; do not claim you changed the draft unless a separate API call applies it.

User request:
${input.prompt}

Draft metadata:
${JSON.stringify({
  draftId: input.draft.draftId,
  draftName: input.draft.draftName,
  source: input.draft.source,
  matchedAt: input.draft.matchedAt,
  filePath: input.draft.filePath,
  rawLength: input.draft.rawLength
}, null, 2)}

Current structured draft JSON:
${JSON.stringify(input.draft.structured, null, 2)}

Current raw Markdown:
${input.draft.rawMarkdown}`;
}

app.post("/api/codex/prompt", async (req, res) => {
  try {
    const body = z.object({
      prompt: z.string().min(1).max(120_000),
      model: z.string().optional(),
      responseFormat: z.enum(["text", "json"]).optional(),
      outputSchema: z.unknown().optional(),
      timeoutMs: z.number().int().min(10_000).max(600_000).default(180_000),
      includeDraft: z.boolean().default(false),
      draftId: z.string().optional()
    }).parse(req.body);
    const model = body.model && body.model !== "default" ? body.model : undefined;
    if (model && !validateModelName(model)) {
      return res.status(400).json({ error: "Invalid model name." });
    }
    if (body.outputSchema !== undefined && (!body.outputSchema || typeof body.outputSchema !== "object" || Array.isArray(body.outputSchema))) {
      return res.status(400).json({ error: "outputSchema must be a JSON object." });
    }

    const retrieval = body.includeDraft || body.draftId
      ? retrieveDrafts({ draftId: body.draftId, source: "current", limit: 1 })
      : undefined;
    const draft = retrieval?.matches[0];
    if ((body.includeDraft || body.draftId) && !draft) {
      return res.status(404).json({ error: "Draft not found." });
    }

    const prompt = draft ? buildPromptWithDraftContext({ prompt: body.prompt, draft }) : body.prompt;
    const result = await runCodexPrompt({
      prompt,
      model,
      responseFormat: body.responseFormat,
      outputSchema: body.outputSchema,
      timeoutMs: body.timeoutMs
    });
    res.json({
      ...result,
      draft: draft ? {
        draftId: draft.draftId,
        draftName: draft.draftName,
        matchedAt: draft.matchedAt,
        rawLength: draft.rawLength,
        filePath: draft.filePath
      } : undefined
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ").slice(0, 4000) });
      return;
    }
    const message = error instanceof Error ? error.message : "Codex prompt failed.";
    res.status(message.includes("Invalid model") || message.includes("schema") ? 400 : 502).json({ error: message.slice(0, 4000) });
  }
});

app.post("/api/codex/edit", async (req, res) => {
  try {
    const body = z.object({
      draftId: z.string(),
      rawMarkdown: z.string().max(200_000),
      draft: updateLogSchema,
      instruction: z.string().min(1).max(8000),
      customEmojis: z.array(customEmojiSchema).default([]),
      model: z.string().optional()
    }).parse(req.body);
    const model = body.model && body.model !== "default" ? body.model : undefined;
    if (model && !validateModelName(model)) {
      return res.status(400).json({ error: "Invalid model name." });
    }
    const result = await runCodexEdit({
      draft: body.draft,
      rawMarkdown: body.rawMarkdown,
      instruction: body.instruction,
      customEmojis: body.customEmojis.length ? body.customEmojis : getSettings().customEmojis,
      model
    });
    recordAiHistory({
      draftId: body.draftId,
      instruction: body.instruction,
      model: model ?? "Codex default",
      summary: result.summary,
      beforeMarkdown: body.rawMarkdown,
      afterMarkdown: result.updatedMarkdown,
      status: "proposed"
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex edit failed.";
    res.status(message.includes("Invalid model") ? 400 : 502).json({ error: message.slice(0, 4000) });
  }
});

app.post("/api/codex/intake", (req, res) => {
  try {
    const body = z.object({
      draftId: z.string().optional(),
      sectionTitle: z.string().trim().min(1).max(80).default("EXTRA"),
      bulletText: z.string().trim().min(1).max(500),
      children: z.array(z.string().trim().max(500)).max(12).default([]),
      source: z.string().trim().max(80).default("codex")
    }).parse(req.body);
    const result = appendCodexIntake(body);
    if (!result) return res.status(404).json({ error: "No draft is available to update." });
    res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex intake failed.";
    res.status(400).json({ error: message.slice(0, 4000) });
  }
});

app.get("/api/codex/intake/daily", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const query = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today)
  }).parse(req.query);
  const entries = listCodexIntakeForDay(query.date);
  res.json({
    date: query.date,
    count: entries.length,
    entries
  });
});

app.post("/api/import", (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    rawMarkdown: z.string().optional(),
    structured: updateLogSchema.optional()
  }).parse(req.body);
  const raw = body.rawMarkdown ?? serializeUpdateLog(body.structured!);
  const draft = createDraft(body.name, raw, body.structured);
  res.status(201).json({ draft });
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const isValidationError = error instanceof z.ZodError;
  const isEmptyOverwriteError = error instanceof Error && error.message.startsWith("Refusing to replace a non-empty draft");
  const message = isValidationError
    ? error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")
    : error instanceof Error ? error.message : "Unexpected server error.";
  res.status(isValidationError ? 400 : isEmptyOverwriteError ? 409 : 500).json({ error: message.slice(0, 4000) });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Update Log Editor API listening on http://127.0.0.1:${port}`);
});
