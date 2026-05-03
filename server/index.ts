import express from "express";
import { z } from "zod";
import {
  appendCodexIntake,
  createDraft,
  createVersion,
  deleteDraft,
  duplicateDraft,
  getDraft,
  getDraftMarkdownPath,
  getSettings,
  importDraftMarkdownFile,
  initDb,
  listAiHistory,
  listCodexIntakeForDay,
  listDrafts,
  listVersions,
  recordAiHistory,
  restoreVersion,
  saveSettings,
  updateDraft
} from "./db";
import { parseUpdateLog, serializeUpdateLog } from "../shared/markdown";
import { splitDiscordMessages } from "../shared/splitter";
import { settingsSchema, updateLogSchema } from "../shared/types";
import { getCodexStatus, runCodexEdit, updateCodexCli, validateModelName } from "./codex";

const app = express();
const port = Number(process.env.PORT ?? 4317);

initDb();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/drafts", (_req, res) => {
  res.json({ drafts: listDrafts() });
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

app.post("/api/drafts/:id/save-version", (req, res) => {
  const existing = getDraft(req.params.id);
  if (!existing) return res.status(404).json({ error: "Draft not found." });
  const body = z.object({
    label: z.string().default("Manual save"),
    name: z.string().min(1).optional(),
    rawMarkdown: z.string().optional(),
    structured: updateLogSchema.optional()
  }).parse(req.body);
  const rawMarkdown = body.rawMarkdown ?? existing.rawMarkdown;
  const structured = body.structured ?? parseUpdateLog(rawMarkdown).log;
  const draft = updateDraft(existing.id, rawMarkdown, structured, body.name) ?? existing;
  const version = createVersion(draft.id, draft.rawMarkdown, draft.structured, body.label);
  res.status(201).json({ version, draft });
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
  res.json({ versions: listVersions(req.params.id) });
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

app.get("/api/codex/status", async (_req, res) => {
  const settings = getSettings();
  const selected = settings.selectedModelMode === "custom" ? settings.customModel : settings.selectedModelMode;
  res.json(await getCodexStatus(selected));
});

app.post("/api/codex/update", async (_req, res) => {
  try {
    res.json(await updateCodexCli());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex update failed.";
    res.status(502).json({ error: message.slice(0, 4000) });
  }
});

app.post("/api/codex/edit", async (req, res) => {
  try {
    const body = z.object({
      draftId: z.string(),
      rawMarkdown: z.string().max(200_000),
      draft: updateLogSchema,
      instruction: z.string().min(1).max(8000),
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

app.listen(port, "127.0.0.1", () => {
  console.log(`Update Log Editor API listening on http://127.0.0.1:${port}`);
});
