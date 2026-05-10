import { parseUpdateLog } from "../../shared/markdown";
import { splitDiscordMessages } from "../../shared/splitter";
import type { ParseResult } from "../../shared/markdown";
import type { SplitOptions, SplitResult } from "../../shared/types";

export type MarkdownAnalysisResult = {
  rawMarkdown: string;
  parsed: ParseResult;
  splitResult: SplitResult;
};

export function analyzeMarkdown(rawMarkdown: string, splitOptions: SplitOptions): MarkdownAnalysisResult {
  return {
    rawMarkdown,
    parsed: parseUpdateLog(rawMarkdown),
    splitResult: splitDiscordMessages(rawMarkdown, splitOptions)
  };
}
