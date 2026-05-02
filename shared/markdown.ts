import type { LogItem, LogSection, UpdateLog } from "./types";

export type ParseResult = {
  log: UpdateLog;
  diagnostics: string[];
};

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

export function parseUpdateLog(raw: string): ParseResult {
  const lines = normalizeNewlines(raw).split("\n");
  const diagnostics: string[] = [];
  let title = "";
  let footer = "";
  const sections: LogSection[] = [];
  let currentSection: LogSection | undefined;
  let currentItem: LogItem | undefined;
  const footerLines: string[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      diagnostics.push(`Line ${index + 1}: code blocks are preserved in raw Markdown but not editable structurally.`);
      continue;
    }

    if (inCodeBlock || trimmed === "") {
      continue;
    }

    if (line.startsWith("-#")) {
      footerLines.push(line);
      footer = footerLines.join("\n");
      continue;
    }

    if (line.startsWith("  -# ")) {
      if (!currentItem) {
        diagnostics.push(`Line ${index + 1}: subtext line has no parent and was skipped structurally.`);
        continue;
      }
      currentItem.footers ??= [];
      currentItem.footers.push(line.slice(5).trim());
      continue;
    }

    if (line.startsWith("## ") && !line.startsWith("### ")) {
      title = line.slice(3).trim();
      continue;
    }

    if (line.startsWith("### ")) {
      currentSection = { title: line.slice(4).trim(), items: [] };
      sections.push(currentSection);
      currentItem = undefined;
      continue;
    }

    if (line.startsWith("- ")) {
      if (!currentSection) {
        currentSection = { title: "GENERAL", items: [] };
        sections.push(currentSection);
        diagnostics.push(`Line ${index + 1}: created GENERAL section for bullet before first section.`);
      }
      currentItem = { text: line.slice(2).trim(), children: [], footers: [] };
      currentSection.items.push(currentItem);
      continue;
    }

    if (line.startsWith("  - ")) {
      if (!currentItem) {
        diagnostics.push(`Line ${index + 1}: nested bullet has no parent and was skipped structurally.`);
        continue;
      }
      currentItem.children.push(line.slice(4).trim());
      continue;
    }

    diagnostics.push(`Line ${index + 1}: unsupported structure is preserved in raw Markdown only.`);
  }

  if (!title) {
    title = "UNTITLED UPDATE";
    diagnostics.push("Missing ## title; using UNTITLED UPDATE structurally.");
  }

  return { log: { title, sections, footer }, diagnostics };
}

export function serializeUpdateLog(log: UpdateLog): string {
  const lines: string[] = [`## ${log.title.trim()}`];

  for (const section of log.sections) {
    lines.push("", `### ${section.title.trim()}`);
    for (const item of section.items) {
      if (!item.text.trim()) {
        continue;
      }
      lines.push(`- ${item.text.trim()}`);
      for (const child of item.children) {
        if (child.trim()) {
          lines.push(`  - ${child.trim()}`);
        }
      }
      for (const footer of item.footers ?? []) {
        if (footer.trim()) {
          lines.push(`  -# ${footer.trim().replace(/^-#\s*/, "")}`);
        }
      }
    }
  }

  if (log.footer.trim()) {
    lines.push("", log.footer.trim());
  }

  return lines.join("\n");
}

export function cloneLog(log: UpdateLog): UpdateLog {
  return {
    title: log.title,
    sections: log.sections.map((section) => ({
      title: section.title,
      items: section.items.map((item) => ({
        text: item.text,
        children: [...item.children],
        footers: [...(item.footers ?? [])]
      }))
    })),
    footer: log.footer
  };
}
