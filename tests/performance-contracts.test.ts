import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { analyzeMarkdown } from "../client/src/markdownAnalysis";
import { parseUpdateLog } from "../shared/markdown";
import { settingsSchema } from "../shared/types";
import { createAutosaveVersion, createDraft, createVersion, deleteDraft, getDraftLatestBackupPath, listDraftBackups, listDraftSummaries, listVersionSummaries, restoreVersion, retrieveDrafts, updateDraft } from "../server/db";

describe("performance contracts", () => {
  test("markdown analysis returns parse and split output together", () => {
    const raw = "## Title\n\n### General\n- One\n- Two";
    const result = analyzeMarkdown(raw, { mode: "custom", customLimit: 24, title: "Title" });

    expect(result.rawMarkdown).toBe(raw);
    expect(result.parsed.log.title).toBe("Title");
    expect(result.splitResult.totalCharacters).toBe(raw.length);
    expect(result.splitResult.chunks.length).toBeGreaterThan(0);
  });

  test("draft and version summary lists do not include full bodies", () => {
    const draft = createDraft(`Perf Test ${Date.now()}`, "## Perf\n\n### General\n- One");
    try {
      const summary = listDraftSummaries().find((candidate) => candidate.id === draft.id);
      expect(summary).toBeTruthy();
      expect(summary?.rawLength).toBe(draft.rawMarkdown.length);
      expect(summary).not.toHaveProperty("rawMarkdown");
      expect(summary).not.toHaveProperty("structured");

      const version = createVersion(draft.id, draft.rawMarkdown, draft.structured, "Perf snapshot");
      const versionSummary = listVersionSummaries(draft.id).find((candidate) => candidate.id === version.id);
      expect(versionSummary).toBeTruthy();
      expect(versionSummary?.rawLength).toBe(draft.rawMarkdown.length);
      expect(versionSummary).not.toHaveProperty("rawMarkdown");
      expect(versionSummary).not.toHaveProperty("structured");
    } finally {
      deleteDraft(draft.id);
    }
  });

  test("autosave history dedupes and prunes storage-heavy snapshots", () => {
    const settings = {
      ...settingsSchema.parse({}),
      autosaveHistoryIntervalMs: 0,
      autosaveHistoryLimit: 3,
      autosaveHistoryMaxBytes: 100000
    };
    const draft = createDraft(`Autosave Perf ${Date.now()}`, "## Auto\n\n### General\n- Seed");
    try {
      const first = updateDraft(draft.id, "## Auto\n\n### General\n- One", parseUpdateLog("## Auto\n\n### General\n- One").log)!;
      const firstVersion = createAutosaveVersion(first, settings);
      expect(firstVersion?.label).toBe("Autosave");
      expect(createAutosaveVersion(first, settings)).toBeUndefined();

      for (let index = 2; index <= 5; index += 1) {
        const raw = `## Auto\n\n### General\n- Change ${index}`;
        const updated = updateDraft(draft.id, raw, parseUpdateLog(raw).log)!;
        createAutosaveVersion(updated, settings);
      }

      const autosaves = listVersionSummaries(draft.id).filter((version) => version.label === "Autosave");
      expect(autosaves).toHaveLength(3);
    } finally {
      deleteDraft(draft.id);
    }
  });

  test("draft updates keep an independent latest markdown backup", () => {
    const draft = createDraft(`Backup Test ${Date.now()}`, "## Backup\n\n### General\n- Seed");
    const latestBackupPath = getDraftLatestBackupPath(draft.id);
    try {
      expect(existsSync(latestBackupPath)).toBe(true);
      expect(readFileSync(latestBackupPath, "utf8")).toBe(draft.rawMarkdown);

      const raw = "## Backup\n\n### General\n- Safer update";
      updateDraft(draft.id, raw, parseUpdateLog(raw).log);

      expect(readFileSync(latestBackupPath, "utf8")).toBe(raw);
      expect(listDraftBackups(draft.id).length).toBeGreaterThan(0);
    } finally {
      deleteDraft(draft.id);
    }

    expect(existsSync(latestBackupPath)).toBe(true);
  });

  test("empty autosave-style updates cannot erase a non-empty draft", () => {
    const raw = "## Guard\n\n### General\n- Keep me";
    const draft = createDraft(`Guard Test ${Date.now()}`, raw);
    try {
      expect(() => updateDraft(draft.id, "", parseUpdateLog("").log)).toThrow(/Refusing to replace/);
      expect(readFileSync(draft.filePath, "utf8")).toBe(raw);
    } finally {
      deleteDraft(draft.id);
    }
  });

  test("codex retrieval can find version snapshots by relative date and text", () => {
    const raw = "## Retrieval Unique\n\n### General\n- Find me from today";
    const draft = createDraft(`Retrieval Test ${Date.now()}`, raw);
    try {
      const version = createVersion(draft.id, raw, draft.structured, "Retrieval marker");
      const result = retrieveDrafts({ when: "today", query: "Find me from today", source: "versions", limit: 5 });
      const match = result.matches.find((candidate) => candidate.id === version.id);

      expect(result.resolvedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(match?.source).toBe("version");
      expect(match?.rawMarkdown).toBe(raw);
      expect(match?.label).toBe("Retrieval marker");
    } finally {
      deleteDraft(draft.id);
    }
  });

  test("restoring a version preserves the overwritten draft as a version first", () => {
    const originalRaw = "## Restore Safety\n\n### General\n- Original";
    const overwrittenRaw = "## Restore Safety\n\n### General\n- Do not lose this";
    const draft = createDraft(`Restore Safety ${Date.now()}`, originalRaw);
    try {
      const restorePoint = createVersion(draft.id, originalRaw, draft.structured, "Original snapshot");
      const overwritten = updateDraft(draft.id, overwrittenRaw, parseUpdateLog(overwrittenRaw).log)!;

      const restored = restoreVersion(restorePoint.id);
      expect(restored?.rawMarkdown).toBe(originalRaw);

      const preserved = listVersionSummaries(draft.id).find((version) => version.label === "Before restore: Original snapshot");
      expect(preserved?.rawLength).toBe(overwritten.rawMarkdown.length);
    } finally {
      deleteDraft(draft.id);
    }
  });
});
