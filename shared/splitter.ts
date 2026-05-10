import type { SplitOptions, SplitResult } from "./types";
import { normalizeNewlines } from "./markdown";

export function getCharacterLimit(options: SplitOptions): number {
  if (options.mode === "nitro") return 4000;
  if (options.mode === "custom") return Math.max(100, Math.min(10000, options.customLimit ?? 2000));
  return 2000;
}

function isFooter(line: string, footer?: string): boolean {
  return line.startsWith("-#") || (!!footer && line.trim() === footer.trim());
}

function splitIntoUnits(raw: string, footer?: string): { body: string[]; footerText: string } {
  const lines = normalizeNewlines(raw).split("\n");
  const footerLines: string[] = [];
  while (lines.length > 0 && (lines.at(-1)?.trim() === "" || isFooter(lines.at(-1) ?? "", footer))) {
    const line = lines.pop();
    if (line && isFooter(line, footer)) {
      footerLines.unshift(line);
    }
  }

  const units: string[] = [];
  let current: string[] = [];
  let currentContainsSection = false;
  let inCode = false;
  let inSpoilerBlock = false;

  const flush = () => {
    while (current.length > 0 && current.at(-1) === "") current.pop();
    if (current.length > 0) {
      units.push(current.join("\n"));
      current = [];
      currentContainsSection = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const startsSection = line.startsWith("### ");
    if (!inCode && !inSpoilerBlock && startsSection && currentContainsSection) {
      flush();
    }

    current.push(line);
    if (startsSection) currentContainsSection = true;
    if (trimmed.startsWith("```")) inCode = !inCode;
    if (trimmed.startsWith("||") && !trimmed.endsWith("||")) inSpoilerBlock = true;
    if (inSpoilerBlock && trimmed.endsWith("||")) inSpoilerBlock = false;
  }
  flush();

  return { body: units, footerText: footerLines.join("\n") };
}

function appendChunk(chunks: string[], text: string) {
  const trimmed = text.trim();
  if (trimmed) chunks.push(trimmed);
}

function withPartHeader(chunk: string, title: string, index: number, total: number): string {
  const partLabel = `PART ${index + 1}/${total}`;
  const header = index === 0 ? `## ${title}, ${partLabel}` : `## ${partLabel}`;
  const lines = chunk.split("\n");
  if (lines[0]?.startsWith("## ") && !lines[0].startsWith("### ")) {
    return [header, ...lines.slice(1)].join("\n").trim();
  }
  return `${header}\n\n${chunk}`;
}

export function splitDiscordMessages(markdown: string, options: SplitOptions): SplitResult {
  const limit = getCharacterLimit(options);
  const source = normalizeNewlines(markdown);
  const totalCharacters = source.length;
  const warnings: string[] = [];
  const { body, footerText } = splitIntoUnits(source, options.footer);
  const chunks: string[] = [];
  let current = "";

  const tryAdd = (unit: string) => {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= limit) {
      current = candidate;
      return;
    }
    appendChunk(chunks, current);
    current = "";

    if (unit.length <= limit) {
      current = unit;
      return;
    }

    current = unit;
  };

  for (const unit of body) {
    tryAdd(unit);
  }

  let finalChunk = current;
  if (footerText) {
    const candidate = finalChunk ? `${finalChunk}\n\n${footerText}` : footerText;
    if (candidate.length <= limit) {
      finalChunk = candidate;
    } else {
      appendChunk(chunks, finalChunk);
      finalChunk = footerText;
      if (footerText.length > limit) {
        warnings.push("Footer exceeds the selected character limit.");
      }
    }
  }
  appendChunk(chunks, finalChunk);

  let finalized = chunks;
  if (options.continuationHeaders && chunks.length > 1 && options.title) {
    finalized = chunks.map((chunk, index) => {
      const candidate = withPartHeader(chunk, options.title!, index, chunks.length);
      if (candidate.length > limit) {
        warnings.push(`Continuation header makes part ${index + 1} exceed the selected limit.`);
      }
      return candidate;
    });
  }

  for (const [index, chunk] of finalized.entries()) {
    if (chunk.length > limit) {
      warnings.push(`Part ${index + 1} exceeds ${limit} characters.`);
    }
  }

  return { chunks: finalized, limit, totalCharacters, warnings };
}
