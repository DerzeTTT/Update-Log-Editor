import type { ParseResult } from "../../shared/markdown";
import type { SplitOptions, SplitResult } from "../../shared/types";
import { analyzeMarkdown } from "./markdownAnalysis";

export type MarkdownWorkerRequest = {
  id: number;
  rawMarkdown: string;
  splitOptions: SplitOptions;
};

export type MarkdownWorkerResponse = {
  id: number;
  rawMarkdown: string;
  parsed: ParseResult;
  splitResult: SplitResult;
};

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const { id, rawMarkdown, splitOptions } = event.data;
  const analysis = analyzeMarkdown(rawMarkdown, splitOptions);
  self.postMessage({
    id,
    ...analysis
  } satisfies MarkdownWorkerResponse);
};
