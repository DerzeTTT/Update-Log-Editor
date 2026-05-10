import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import Editor from "@monaco-editor/react";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { diffLines } from "diff";
import {
  Bot,
  Check,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  FilePlus,
  FileText,
  GripVertical,
  History,
  Eye,
  ListPlus,
  MessagesSquare,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Settings,
  SmilePlus,
  Trash2,
  X
} from "lucide-react";
import { cloneLog, parseUpdateLog, serializeUpdateLog } from "../../shared/markdown";
import { splitDiscordMessages } from "../../shared/splitter";
import { genericEmojiCatalog, type AiEditResponse, type AppSettings, type CustomEmoji, type DraftRecord, type LogItem, type UpdateLog, type VersionRecord } from "../../shared/types";
import "./styles.css";

type DraftsResponse = { drafts: DraftRecord[] };
type DraftResponse = { draft: DraftRecord };
type SettingsResponse = { settings: AppSettings };
type UploadEmojiResponse = { emoji: CustomEmoji };
type VersionsResponse = { versions: VersionRecord[] };
type SaveVersionResponse = { version: VersionRecord; draft: DraftRecord };
type SelectOption = { value: string; label: string; meta?: string };
type EditorTab = "raw" | "structured";
type SideTab = "preview" | "emojis" | "split" | "ai" | "history" | "settings";
type SlideDirection = "slideForward" | "slideBack";
type BulletDragLocation = { sectionIndex: number; itemIndex: number };
type BulletDropTarget = BulletDragLocation & { side: "before" | "after" };
type BulletDragSession = {
  source: BulletDragLocation;
  element: HTMLElement;
  pointerId: number;
  pointerStartY: number;
  scrollStartTop: number;
  pointerX: number;
  pointerY: number;
  target: BulletDropTarget | null;
  targetElement: HTMLElement | null;
  rafId: number | null;
  autoScrollRafId: number | null;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
};
type AmbientGlow = {
  id: number;
  color: string;
  size: string;
  x: string;
  y: string;
  dx: string;
  dy: string;
  duration: string;
};
const sectionMenuOptionsLimit = 12;
const everyoneFooter = "-# ||@everyone||";
const editorTabOrder: EditorTab[] = ["raw", "structured"];
const sideTabOrder: SideTab[] = ["preview", "emojis", "split", "ai", "history", "settings"];
const markdownInputCommitDelayMs = 650;
const rawParseDebounceMs = 360;
const codexStatusQueryOptions = {
  staleTime: 30_000,
  refetchOnWindowFocus: false
};
const emojiAliasPattern = /:([A-Za-z0-9_+-]{1,64}):/g;

const queryClient = new QueryClient();

type EmojiCatalogEntry = CustomEmoji & { source: "generic" | "custom" };

function sanitizeEmojiName(value: string): string {
  return value
    .trim()
    .replace(/^:+|:+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_+-]/g, "")
    .slice(0, 64);
}

function emojiToken(name: string): string {
  return `:${name}:`;
}

function isEmojiImage(value: string): boolean {
  return /^(data:image\/|\/api\/custom-emojis\/|https?:\/\/)/i.test(value);
}

function EmojiVisual({ value, token, className = "emojiInline" }: { value: string; token: string; className?: string }) {
  return isEmojiImage(value)
    ? <img className={className} src={value} alt={token} title={token} />
    : <span className={className} title={token}>{value}</span>;
}

function buildEmojiCatalog(customEmojis: CustomEmoji[] = []): EmojiCatalogEntry[] {
  const entries: EmojiCatalogEntry[] = genericEmojiCatalog.map((emoji) => ({
    name: emoji.name,
    emoji: emoji.emoji,
    source: "generic" as const
  }));
  for (const emoji of customEmojis) {
    const name = sanitizeEmojiName(emoji.name);
    const value = emoji.emoji.trim();
    if (!name || !value) continue;
    const key = name.toLowerCase();
    const existingIndex = entries.findIndex((entry) => entry.name.toLowerCase() === key);
    if (existingIndex >= 0) {
      entries[existingIndex] = { name, emoji: value, source: "custom" };
      continue;
    }
    entries.push({ name, emoji: value, source: "custom" });
  }
  return entries;
}

function buildEmojiMap(customEmojis: CustomEmoji[] = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of buildEmojiCatalog(customEmojis)) {
    map.set(entry.name.toLowerCase(), entry.emoji);
  }
  return map;
}

function renderPlainTextWithEmojis(text: string, emojiMap: Map<string, string>): React.ReactNode[] {
  if (!emojiMap.size) return [text];
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(emojiAliasPattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const name = match[1];
    const emoji = emojiMap.get(name.toLowerCase());
    const token = match[0];
    parts.push(
      emoji ? (
        <EmojiVisual value={emoji} token={token} key={`emoji-${match.index}-${token}`} />
      ) : token
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function createAmbientGlow(id: number): AmbientGlow {
  const colors = [
    "rgba(76,131,255,0.42)",
    "rgba(36,161,222,0.34)",
    "rgba(255,104,117,0.24)",
    "rgba(155,115,255,0.30)"
  ];
  return {
    id,
    color: colors[Math.floor(Math.random() * colors.length)],
    size: `${440 + Math.round(Math.random() * 360)}px`,
    x: `${Math.round(-10 + Math.random() * 105)}vw`,
    y: `${Math.round(-12 + Math.random() * 98)}vh`,
    dx: `${Math.round(-22 + Math.random() * 44)}vw`,
    dy: `${Math.round(-18 + Math.random() * 36)}vh`,
    duration: `${15000 + Math.round(Math.random() * 8000)}ms`
  };
}

const AmbientGlows = React.memo(function AmbientGlows() {
  const [ambientGlows, setAmbientGlows] = useState<AmbientGlow[]>([]);

  useEffect(() => {
    let nextId = 1;
    const spawn = () => {
      const glow = createAmbientGlow(nextId++);
      setAmbientGlows((current) => [...current.slice(-3), glow]);
      window.setTimeout(() => {
        setAmbientGlows((current) => current.filter((entry) => entry.id !== glow.id));
      }, Number.parseInt(glow.duration, 10) + 900);
    };
    spawn();
    const interval = window.setInterval(spawn, 4300);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="ambientGlows" aria-hidden="true">
      {ambientGlows.map((glow) => (
        <span
          key={glow.id}
          className="ambientGlow"
          style={{
            "--glow-color": glow.color,
            "--glow-size": glow.size,
            "--glow-x": glow.x,
            "--glow-y": glow.y,
            "--glow-dx": glow.dx,
            "--glow-dy": glow.dy,
            "--glow-duration": glow.duration
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
});

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read emoji image."));
    reader.readAsDataURL(file);
  });
}

function hasEveryoneFooter(value: string) {
  return value.split("\n").some((line) => line.trim() === everyoneFooter);
}

function setEveryoneFooter(value: string, enabled: boolean) {
  const remaining = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== everyoneFooter);
  if (enabled) {
    remaining.push(everyoneFooter);
  }
  return remaining.join("\n");
}

function displayModelName(model: string) {
  return model.replace(/\bgpt\b/gi, "GPT").replace(/\bgpt-/gi, "GPT-");
}

function draftNameFromUpdateTitle(title: string) {
  const withoutHeading = title.replace(/^#+\s*/, "");
  const withoutEmoji = withoutHeading.replace(/:[A-Za-z0-9_+-]+:/g, "").replace(/\s+/g, " ").trim();
  const withoutUpdateSuffix = withoutEmoji.replace(/\s+UPDATE$/i, "").trim();
  return withoutUpdateSuffix || withoutEmoji || "Untitled Update";
}

function renderStructuredInlineMarkdown(value: string) {
  const tokens = [
    { marker: "**", className: "mdStrong" },
    { marker: "__", className: "mdUnderline" },
    { marker: "~~", className: "mdStrike" },
    { marker: "||", className: "mdSpoiler" },
    { marker: "`", className: "mdCode" },
    { marker: "*", className: "mdEm" }
  ];
  const parts: React.ReactNode[] = [];
  let index = 0;

  while (index < value.length) {
    const token = tokens.find((entry) => value.startsWith(entry.marker, index));
    if (!token) {
      parts.push(value[index]);
      index += 1;
      continue;
    }

    const contentStart = index + token.marker.length;
    const contentEnd = value.indexOf(token.marker, contentStart);
    if (contentEnd <= contentStart) {
      parts.push(value[index]);
      index += 1;
      continue;
    }

    parts.push(<span key={`m-open-${index}`} className="mdMarker">{token.marker}</span>);
    parts.push(<span key={`m-content-${index}`} className={token.className}>{value.slice(contentStart, contentEnd)}</span>);
    parts.push(<span key={`m-close-${index}`} className="mdMarker">{token.marker}</span>);
    index = contentEnd + token.marker.length;
  }

  return parts;
}

const MarkdownTextInput = React.memo(function MarkdownTextInput({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  const commitTimeoutRef = useRef<number | null>(null);
  const hasPendingCommitRef = useRef(false);
  const latestValueRef = useRef(value);
  const lastCommittedValueRef = useRef(value);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    lastCommittedValueRef.current = value;
    if (!isFocused && latestValueRef.current !== value) {
      latestValueRef.current = value;
      setLocalValue(value);
    }
  }, [value, isFocused]);

  const clearCommitTimeout = () => {
    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = null;
    }
  };

  const commit = (next: string) => {
    clearCommitTimeout();
    hasPendingCommitRef.current = false;
    latestValueRef.current = next;
    if (next !== lastCommittedValueRef.current) {
      lastCommittedValueRef.current = next;
      onChangeRef.current(next);
    }
  };

  const scheduleCommit = (next: string) => {
    latestValueRef.current = next;
    hasPendingCommitRef.current = true;
    clearCommitTimeout();
    commitTimeoutRef.current = window.setTimeout(() => commit(next), markdownInputCommitDelayMs);
  };

  useEffect(() => () => {
    if (hasPendingCommitRef.current) {
      commit(latestValueRef.current);
    } else {
      clearCommitTimeout();
    }
  }, []);

  const preview = useMemo(() => {
    if (isFocused) return null;
    return renderStructuredInlineMarkdown(localValue);
  }, [isFocused, localValue]);

  return (
    <span className={`markdownTextInput ${isFocused ? "editing" : ""} ${className ?? ""}`}>
      <span className="markdownTextPreview" aria-hidden="true">
        {preview}
      </span>
      <input
        className="markdownTextControl"
        value={localValue}
        placeholder={placeholder}
        onFocus={() => setIsFocused(true)}
        onChange={(event) => {
          const nextValue = event.target.value;
          latestValueRef.current = nextValue;
          setLocalValue(nextValue);
          scheduleCommit(nextValue);
        }}
        onBlur={(event) => {
          commit(event.target.value);
          setIsFocused(false);
        }}
      />
    </span>
  );
}, (previous, next) =>
  previous.value === next.value &&
  previous.placeholder === next.placeholder &&
  previous.className === next.className
);

type MonacoEditorLike = {
  getValue: () => string;
  setValue: (value: string) => void;
  getSelection: () => unknown;
  setSelection: (selection: any) => void;
  getScrollTop: () => number;
  setScrollTop: (value: number) => void;
  getScrollLeft: () => number;
  setScrollLeft: (value: number) => void;
};

function RawMarkdownEditor({
  value,
  syncVersion,
  isActive,
  onChange
}: {
  value: string;
  syncVersion: number;
  isActive: boolean;
  onChange: (value: string) => void;
}) {
  const editorRef = useRef<MonacoEditorLike | null>(null);
  const latestValueRef = useRef(value);
  const applyingExternalValueRef = useRef(false);
  latestValueRef.current = value;

  useEffect(() => {
    if (!isActive) return;
    const editor = editorRef.current;
    const nextValue = latestValueRef.current;
    if (!editor || editor.getValue() === nextValue) return;

    const selection = editor.getSelection();
    const scrollTop = editor.getScrollTop();
    const scrollLeft = editor.getScrollLeft();

    try {
      applyingExternalValueRef.current = true;
      editor.setValue(nextValue);
      if (selection) editor.setSelection(selection);
      editor.setScrollTop(scrollTop);
      editor.setScrollLeft(scrollLeft);
    } finally {
      applyingExternalValueRef.current = false;
    }
  }, [syncVersion, isActive]);

  return (
    <Editor
      height="100%"
      defaultLanguage="markdown"
      defaultValue={value}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        wordWrap: "on",
        fontSize: 14,
        lineHeight: 22,
        tabSize: 2,
        automaticLayout: isActive,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: "off",
        tabCompletion: "off",
        wordBasedSuggestions: "off",
        parameterHints: { enabled: false },
        inlineSuggest: { enabled: false },
        padding: { top: 10, bottom: 18 },
        unicodeHighlight: {
          ambiguousCharacters: false,
          invisibleCharacters: false,
          nonBasicASCII: false
        }
      }}
      onMount={(editor) => {
        editorRef.current = editor as MonacoEditorLike;
        const latestValue = latestValueRef.current;
        if (editor.getValue() !== latestValue) {
          try {
            applyingExternalValueRef.current = true;
            editor.setValue(latestValue);
          } finally {
            applyingExternalValueRef.current = false;
          }
        }
      }}
      onChange={(nextValue) => {
        if (!applyingExternalValueRef.current) {
          onChange(nextValue ?? "");
        }
      }}
    />
  );
}

function App() {
  const [selectedDraftId, setSelectedDraftId] = useState<string>("");
  const [tab, setTab] = useState<EditorTab>("raw");
  const [sideTab, setSideTab] = useState<SideTab>("preview");
  const [editorSlideDirection, setEditorSlideDirection] = useState<SlideDirection>("slideForward");
  const [sideSlideDirection, setSideSlideDirection] = useState<SlideDirection>("slideForward");
  const [rawMarkdown, setRawMarkdown] = useState("");
  const [structured, setStructured] = useState<UpdateLog>({ title: "", sections: [], footer: "" });
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [draftName, setDraftName] = useState("");
  const [copyToast, setCopyToast] = useState("");
  const [confirmDeleteDraftId, setConfirmDeleteDraftId] = useState<string | null>(null);
  const [lastManualSaveAt, setLastManualSaveAt] = useState<string>("");
  const [rawEditorSyncVersion, setRawEditorSyncVersion] = useState(0);
  const hydratedDraftIdRef = useRef("");
  const rawParseTimeoutRef = useRef<number | null>(null);
  const [, startRawParseTransition] = useTransition();
  const queryClient = useQueryClient();

  const draftsQuery = useQuery({
    queryKey: ["drafts"],
    queryFn: () => api<DraftsResponse>("/api/drafts"),
    refetchInterval: 4000,
    refetchIntervalInBackground: true
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings")
  });
  useQuery({
    queryKey: ["codex-status"],
    queryFn: () => api<any>("/api/codex/status"),
    refetchOnMount: true,
    ...codexStatusQueryOptions
  });
  const activeDraft = draftsQuery.data?.drafts.find((draft) => draft.id === selectedDraftId) ?? draftsQuery.data?.drafts[0];
  const draftToDelete = draftsQuery.data?.drafts.find((draft) => draft.id === confirmDeleteDraftId);
  const deferredRawMarkdown = useDeferredValue(rawMarkdown);
  const deferredStructured = useDeferredValue(structured);
  const customEmojis = settingsQuery.data?.settings.customEmojis ?? [];
  const emojiMap = useMemo(() => buildEmojiMap(customEmojis), [customEmojis]);

  const hydrateDraft = (draft: DraftRecord) => {
    hydratedDraftIdRef.current = draft.id;
    setRawMarkdown(draft.rawMarkdown);
    setStructured(draft.structured);
    setDraftName(draft.name);
    setDiagnostics(parseUpdateLog(draft.rawMarkdown).diagnostics);
    setRawEditorSyncVersion((version) => version + 1);
  };

  const parseRawIntoStructured = useCallback((value: string) => {
    if (rawParseTimeoutRef.current !== null) {
      window.clearTimeout(rawParseTimeoutRef.current);
      rawParseTimeoutRef.current = null;
    }
    const parsed = parseUpdateLog(value);
    startRawParseTransition(() => {
      setStructured(parsed.log);
      setDiagnostics(parsed.diagnostics);
    });
  }, []);

  const selectDraft = (draft: DraftRecord) => {
    if (draft.id === selectedDraftId) return;
    const drafts = draftsQuery.data?.drafts ?? [];
    const currentIndex = drafts.findIndex((entry) => entry.id === selectedDraftId);
    const nextIndex = drafts.findIndex((entry) => entry.id === draft.id);
    const direction: SlideDirection = currentIndex >= 0 && nextIndex > currentIndex ? "slideForward" : "slideBack";
    setEditorSlideDirection(direction);
    setSideSlideDirection(direction);
    setSelectedDraftId(draft.id);
    hydrateDraft(draft);
  };

  const switchEditorTab = (next: EditorTab) => {
    if (next === tab) return;
    if (next === "structured" && tab === "raw") {
      parseRawIntoStructured(rawMarkdown);
    }
    setEditorSlideDirection(editorTabOrder.indexOf(next) > editorTabOrder.indexOf(tab) ? "slideForward" : "slideBack");
    setTab(next);
  };

  const switchSideTab = (next: SideTab) => {
    if (next === sideTab) return;
    setSideSlideDirection(sideTabOrder.indexOf(next) > sideTabOrder.indexOf(sideTab) ? "slideForward" : "slideBack");
    setSideTab(next);
  };

  useEffect(() => {
    if (!selectedDraftId && draftsQuery.data?.drafts[0]) {
      selectDraft(draftsQuery.data.drafts[0]);
    }
  }, [draftsQuery.data, selectedDraftId]);

  useEffect(() => {
    if (!activeDraft) return;
    if (activeDraft.id === hydratedDraftIdRef.current) return;
    hydrateDraft(activeDraft);
  }, [activeDraft?.id]);

  useEffect(() => () => {
    if (rawParseTimeoutRef.current !== null) {
      window.clearTimeout(rawParseTimeoutRef.current);
    }
  }, []);

  const saveMutation = useMutation({
    mutationFn: (payload: { name?: string; rawMarkdown: string; structured: UpdateLog }) =>
      api<DraftResponse>(`/api/drafts/${selectedDraftId}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<DraftsResponse>(["drafts"], (previous) => {
        if (!previous) return { drafts: [data.draft] };
        return { drafts: previous.drafts.map((draft) => (draft.id === data.draft.id ? data.draft : draft)) };
      });
    }
  });

  useEffect(() => {
    if (!selectedDraftId || !settingsQuery.data) return;
    const timeout = window.setTimeout(() => {
      const latestStructured = tab === "raw" ? parseUpdateLog(rawMarkdown).log : structured;
      saveMutation.mutate({ name: draftName, rawMarkdown, structured: latestStructured });
    }, settingsQuery.data.settings.autosaveIntervalMs);
    return () => window.clearTimeout(timeout);
  }, [rawMarkdown, structured, draftName, selectedDraftId, tab, settingsQuery.data?.settings.autosaveIntervalMs]);

  const createDraft = useMutation({
    mutationFn: () => api<DraftResponse>("/api/drafts", { method: "POST", body: JSON.stringify({ name: "Untitled Update" }) }),
    onSuccess: (data) => {
      queryClient.setQueryData<DraftsResponse>(["drafts"], (previous) => {
        if (!previous) return { drafts: [data.draft] };
        return { drafts: [data.draft, ...previous.drafts.filter((draft) => draft.id !== data.draft.id)] };
      });
      hydrateDraft(data.draft);
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      setSelectedDraftId(data.draft.id);
    }
  });

  const duplicateDraft = useMutation({
    mutationFn: (id: string) => api<DraftResponse>(`/api/drafts/${id}/duplicate`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      setSelectedDraftId(data.draft.id);
    }
  });

  const deleteDraft = useMutation({
    mutationFn: (id: string) => api<void>(`/api/drafts/${id}`, { method: "DELETE" }),
    onSuccess: (_data, deletedId) => {
      setConfirmDeleteDraftId(null);
      queryClient.setQueryData<DraftsResponse>(["drafts"], (previous) => {
        if (!previous) return previous;
        return { drafts: previous.drafts.filter((draft) => draft.id !== deletedId) };
      });
      if (selectedDraftId === deletedId) {
        setSelectedDraftId("");
      }
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    }
  });

  const updateSettings = useMutation({
    mutationFn: (settings: AppSettings) => api<SettingsResponse>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
    }
  });

  const saveVersion = useMutation({
    mutationFn: () => {
      if (!selectedDraftId) throw new Error("No draft selected.");
      const latestStructured = tab === "raw" ? parseUpdateLog(rawMarkdown).log : structured;
      const nextName = draftNameFromUpdateTitle(latestStructured.title || draftName);
      return api<SaveVersionResponse>(`/api/drafts/${selectedDraftId}/save-version`, {
        method: "POST",
        body: JSON.stringify({
          label: "Manual save",
          name: nextName,
          rawMarkdown,
          structured: latestStructured
        })
      });
    },
    onSuccess: (data) => {
      setDraftName(data.draft.name);
      setLastManualSaveAt(data.version.createdAt);
      queryClient.setQueryData<DraftsResponse>(["drafts"], (previous) => {
        if (!previous) return { drafts: [data.draft] };
        const nextDrafts = previous.drafts.map((draft) => (draft.id === data.draft.id ? data.draft : draft));
        if (!nextDrafts.some((draft) => draft.id === data.draft.id)) nextDrafts.unshift(data.draft);
        return { drafts: nextDrafts };
      });
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      queryClient.invalidateQueries({ queryKey: ["versions", data.draft.id] });
    }
  });

  const updateFromRaw = useCallback((value: string) => {
    setRawMarkdown(value);
    if (rawParseTimeoutRef.current !== null) {
      window.clearTimeout(rawParseTimeoutRef.current);
    }
    rawParseTimeoutRef.current = window.setTimeout(() => {
      parseRawIntoStructured(value);
    }, rawParseDebounceMs);
  }, [parseRawIntoStructured]);

  const updateStructured = useCallback((next: UpdateLog) => {
    setStructured(next);
    setRawMarkdown(serializeUpdateLog(next));
    setDiagnostics([]);
    setRawEditorSyncVersion((version) => version + 1);
  }, []);

  const splitResult = useMemo(() => {
    const settings = settingsQuery.data?.settings;
    return splitDiscordMessages(deferredRawMarkdown, {
      mode: settings?.characterLimitMode ?? "normal",
      customLimit: settings?.customLimit,
      continuationHeaders: settings?.continuationHeaders,
      title: deferredStructured.title,
      footer: deferredStructured.footer
    });
  }, [deferredRawMarkdown, settingsQuery.data?.settings, deferredStructured.title, deferredStructured.footer]);

  const toastCopy = async (text: string, label: string) => {
    await copyText(text);
    setCopyToast(label);
    window.setTimeout(() => setCopyToast(""), 1300);
  };

  return (
    <div className="app">
      <AmbientGlows />
      <aside className="sidebar">
        <div className="brand">
          <Moon size={20} />
          <div>
            <strong>Update Log Editor</strong>
            <span>Discord patch notes</span>
          </div>
        </div>
        <button className="primary" disabled={createDraft.isPending} onClick={() => createDraft.mutate()}>
          <FilePlus size={16} /> {createDraft.isPending ? "Creating..." : "New Draft"}
        </button>
        <div className="draftList">
          {draftsQuery.data?.drafts.map((draft) => (
            <div key={draft.id} className={draft.id === selectedDraftId ? "draftRow active" : "draftRow"}>
              <button className="draft" onClick={() => selectDraft(draft)}>
                <span className="draftText">
                  <strong>{draft.name}</strong>
                  <span>{new Date(draft.updatedAt).toLocaleString()}</span>
                </span>
              </button>
              <button
                className="iconButton draftDeleteButton"
                title={`Delete ${draft.name}`}
                onClick={() => setConfirmDeleteDraftId(draft.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <input value={draftName} onChange={(event) => setDraftName(event.target.value)} className="titleInput" />
          <div className="actions">
            {copyToast && <span className="toast">{copyToast}</span>}
            {activeDraft?.filePath && (
              <button title="Copy Markdown file path" onClick={() => toastCopy(activeDraft.filePath, ".md path copied")}>
                <FileText size={16} /> Copy .md path
              </button>
            )}
            <button disabled={!selectedDraftId || saveVersion.isPending} title="Save version" onClick={() => saveVersion.mutate()}>
              <Save size={16} /> {saveVersion.isPending ? "Saving..." : "Save"}
            </button>
            <button disabled={!selectedDraftId || duplicateDraft.isPending} title="Duplicate" onClick={() => selectedDraftId && duplicateDraft.mutate(selectedDraftId)}>
              <Copy size={16} /> Duplicate
            </button>
            <button className="dangerButton" disabled={!selectedDraftId} title="Delete draft" onClick={() => selectedDraftId && setConfirmDeleteDraftId(selectedDraftId)}>
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </header>

        <section className="contentGrid">
          <div className="editorPane">
            <div className="tabs editorTabs">
              <div className="editorTabButtons">
                <button className={tab === "raw" ? "active" : ""} onClick={() => switchEditorTab("raw")}>Raw Markdown</button>
                <button className={tab === "structured" ? "active" : ""} onClick={() => switchEditorTab("structured")}>Structured</button>
              </div>
              <button className="primary saveVersionTabButton" disabled={!selectedDraftId || saveVersion.isPending} onClick={() => saveVersion.mutate()}>
                <Save size={15} /> {saveVersion.isPending ? "Saving..." : "Save Version"}
              </button>
            </div>
            <div className={`editorMode ${tab === "raw" ? `active ${editorSlideDirection}` : "inactive"} monacoShell`} aria-hidden={tab !== "raw"}>
                <RawMarkdownEditor value={rawMarkdown} syncVersion={rawEditorSyncVersion} isActive={tab === "raw"} onChange={updateFromRaw} />
              </div>
              <div className={`editorMode ${tab === "structured" ? `active ${editorSlideDirection}` : "inactive"} structuredShell`} aria-hidden={tab !== "structured"}>
                <StructuredEditor
                  log={structured}
                  onChange={updateStructured}
                  onSave={() => saveVersion.mutate()}
                  isSaving={saveVersion.isPending}
                  lastSavedAt={lastManualSaveAt}
                />
              </div>
            {diagnostics.length > 0 && (
              <div className="diagnostics">
                {diagnostics.slice(0, 4).map((diagnostic) => <span key={diagnostic}>{diagnostic}</span>)}
              </div>
            )}
          </div>

          <div className="sidePane">
            <div className="tabs">
              <button className={sideTab === "preview" ? "active" : ""} onClick={() => switchSideTab("preview")}><Eye size={14} /> Preview</button>
              <button className={sideTab === "emojis" ? "active" : ""} onClick={() => switchSideTab("emojis")}><SmilePlus size={14} /> Emojis</button>
              <button className={sideTab === "split" ? "active" : ""} onClick={() => switchSideTab("split")}><MessagesSquare size={14} /> Messages</button>
              <button className={sideTab === "ai" ? "active" : ""} onClick={() => switchSideTab("ai")}><Bot size={14} /> AI</button>
              <button className={sideTab === "history" ? "active" : ""} onClick={() => switchSideTab("history")}><History size={14} /> History</button>
              <button className={sideTab === "settings" ? "active" : ""} onClick={() => switchSideTab("settings")}><Settings size={14} /> Settings</button>
            </div>
            <div className="sideContent">
              <div className={`sideMode ${sideTab === "preview" ? `active ${sideSlideDirection}` : "inactive"}`} aria-hidden={sideTab !== "preview"}>
                {sideTab === "preview" && <Preview rawMarkdown={deferredRawMarkdown} splitResult={splitResult} emojiMap={emojiMap} />}
              </div>
              <div className={`sideMode ${sideTab === "emojis" ? `active ${sideSlideDirection}` : "inactive"}`} aria-hidden={sideTab !== "emojis"}>
                {sideTab === "emojis" && settingsQuery.data && <EmojiPanel
                  settings={settingsQuery.data.settings}
                  onChange={(settings) => updateSettings.mutate(settings)}
                  onCopy={toastCopy}
                />}
              </div>
              <div className={`sideMode ${sideTab === "split" ? `active ${sideSlideDirection}` : "inactive"}`} aria-hidden={sideTab !== "split"}>
                {sideTab === "split" && <SplitPanel
                  result={splitResult}
                  onCopy={toastCopy}
                  rawMarkdown={deferredRawMarkdown}
                  settings={settingsQuery.data?.settings}
                  onTogglePartHeaders={(enabled) => {
                    const current = settingsQuery.data?.settings;
                    if (current) updateSettings.mutate({ ...current, continuationHeaders: enabled });
                  }}
                />}
              </div>
              <div className={`sideMode ${sideTab === "ai" ? `active ${sideSlideDirection}` : "inactive"}`} aria-hidden={sideTab !== "ai"}>
                {activeDraft && <AiPanel draftId={activeDraft.id} rawMarkdown={rawMarkdown} structured={structured} customEmojis={customEmojis} onApply={updateStructured} />}
              </div>
              <div className={`sideMode ${sideTab === "history" ? `active ${sideSlideDirection}` : "inactive"}`} aria-hidden={sideTab !== "history"}>
                {sideTab === "history" && activeDraft && <HistoryPanel draftId={activeDraft.id} />}
              </div>
              <div className={`sideMode ${sideTab === "settings" ? `active ${sideSlideDirection}` : "inactive"}`} aria-hidden={sideTab !== "settings"}>
                {sideTab === "settings" && settingsQuery.data && <SettingsPanel settings={settingsQuery.data.settings} />}
              </div>
            </div>
          </div>
        </section>
        {draftToDelete && (
          <div className="modalBackdrop" role="dialog" aria-modal="true">
            <div className="confirmModal">
              <h3>Delete Draft?</h3>
              <p>This removes <strong>{draftToDelete.name}</strong> and its saved versions from this local app.</p>
              <div className="modalActions">
                <button onClick={() => setConfirmDeleteDraftId(null)}>Cancel</button>
                <button className="dangerButton" disabled={deleteDraft.isPending} onClick={() => deleteDraft.mutate(draftToDelete.id)}>
                  <Trash2 size={16} /> {deleteDraft.isPending ? "Deleting..." : "Delete Draft"}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function CustomSelect({
  value,
  options,
  onChange,
  label,
  compact = false,
  dense = false,
  buttonLabel,
  buttonMeta
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label?: string;
  compact?: boolean;
  dense?: boolean;
  buttonLabel?: string;
  buttonMeta?: string;
}) {
  const [menuState, setMenuState] = useState<"closed" | "open" | "closing">("closed");
  const closeTimer = useRef<number | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const open = menuState === "open";
  const menuVisible = menuState !== "closed";

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const openMenu = () => {
    clearCloseTimer();
    setMenuState("open");
  };

  const closeMenu = () => {
    clearCloseTimer();
    if (menuState === "closed") return;
    setMenuState("closing");
    closeTimer.current = window.setTimeout(() => {
      setMenuState("closed");
      closeTimer.current = null;
    }, 150);
  };

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div
      className={`${compact ? "customSelect compact" : "customSelect"}${dense ? " dense" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closeMenu();
        }
      }}
    >
      {label && <span className="customSelectLabel">{label}</span>}
      <button
        type="button"
        className={open ? "customSelectButton open" : "customSelectButton"}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        <span>
          <strong>{buttonLabel ?? selected?.label ?? "Select"}</strong>
          {(buttonMeta ?? selected?.meta) && <small>{buttonMeta ?? selected?.meta}</small>}
        </span>
        <ChevronDown size={15} className="chevron" />
      </button>
      {menuVisible && (
        <div className={menuState === "closing" ? "customSelectMenu closing" : "customSelectMenu open"} tabIndex={-1}>
          {options.slice(0, sectionMenuOptionsLimit).map((option) => (
            <button
              type="button"
              key={option.value}
              className={option.value === value ? "selected" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                closeMenu();
              }}
            >
              <span>{option.label}</span>
              {option.meta && <small>{option.meta}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const StructuredEditor = React.memo(function StructuredEditor({
  log,
  onChange,
  onSave,
  isSaving,
  lastSavedAt
}: {
  log: UpdateLog;
  onChange: (log: UpdateLog) => void;
  onSave: () => void;
  isSaving: boolean;
  lastSavedAt: string;
}) {
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [localLog, setLocalLog] = useState(log);
  const [, startTransition] = useTransition();
  const structuredRef = useRef<HTMLDivElement>(null);
  const collapsedSectionsRef = useRef<Set<number>>(new Set());
  const localLogRef = useRef(log);
  const lastPropagatedLogRef = useRef<UpdateLog | null>(null);
  const commitTimeoutRef = useRef<number | null>(null);
  const bulletDragSessionRef = useRef<BulletDragSession | null>(null);
  localLogRef.current = localLog;

  useEffect(() => {
    if (log === lastPropagatedLogRef.current) return;
    localLogRef.current = log;
    setLocalLog(log);
  }, [log]);

  useEffect(() => () => {
    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
    }
  }, []);

  const commitLog = (next: UpdateLog, immediate = false) => {
    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = null;
    }
    const propagate = () => {
      lastPropagatedLogRef.current = next;
      startTransition(() => onChange(next));
    };
    if (immediate) {
      propagate();
    } else {
      commitTimeoutRef.current = window.setTimeout(propagate, 1500);
    }
  };

  const sectionOptions = localLog.sections.map((section, index) => ({
    value: String(index),
    label: section.title || `Section ${index + 1}`,
    meta: `${section.items.length} bullet${section.items.length === 1 ? "" : "s"}`
  }));
  const clampedActiveSectionIndex = Math.min(activeSectionIndex, Math.max(0, localLog.sections.length - 1));

  const setLog = (mutator: (draft: UpdateLog) => void, immediate = false) => {
    const next = cloneLog(localLogRef.current);
    mutator(next);
    applyLocalLog(next, immediate);
  };

  const applyLocalLog = (next: UpdateLog, immediate = false) => {
    localLogRef.current = next;
    setLocalLog(next);
    commitLog(next, immediate);
  };

  const updateTitle = (value: string) => {
    applyLocalLog({ ...localLogRef.current, title: value });
  };

  const updateSectionTitle = (sectionIndex: number, value: string) => {
    const current = localLogRef.current;
    const sections = [...current.sections];
    sections[sectionIndex] = { ...sections[sectionIndex], title: value };
    applyLocalLog({ ...current, sections });
  };

  const updateItemText = (sectionIndex: number, itemIndex: number, value: string) => {
    const current = localLogRef.current;
    const sections = [...current.sections];
    const section = sections[sectionIndex];
    const items = [...section.items];
    items[itemIndex] = { ...items[itemIndex], text: value };
    sections[sectionIndex] = { ...section, items };
    applyLocalLog({ ...current, sections });
  };

  const updateChildText = (sectionIndex: number, itemIndex: number, childIndex: number, value: string) => {
    const current = localLogRef.current;
    const sections = [...current.sections];
    const section = sections[sectionIndex];
    const items = [...section.items];
    const item = items[itemIndex];
    const children = [...item.children];
    children[childIndex] = value;
    items[itemIndex] = { ...item, children };
    sections[sectionIndex] = { ...section, items };
    applyLocalLog({ ...current, sections });
  };

  const updateItemFooter = (sectionIndex: number, itemIndex: number, footerIndex: number, value: string) => {
    const current = localLogRef.current;
    const sections = [...current.sections];
    const section = sections[sectionIndex];
    const items = [...section.items];
    const item = items[itemIndex];
    const footers = [...(item.footers ?? [])];
    footers[footerIndex] = value;
    items[itemIndex] = { ...item, footers };
    sections[sectionIndex] = { ...section, items };
    applyLocalLog({ ...current, sections });
  };

  const updateBottomFooter = (value: string) => {
    applyLocalLog({ ...localLogRef.current, footer: value });
  };

  const moveSection = (index: number, direction: -1 | 1) => setLog((draft) => {
    const target = index + direction;
    if (target < 0 || target >= draft.sections.length) return;
    const [section] = draft.sections.splice(index, 1);
    draft.sections.splice(target, 0, section);
  }, true);

  const moveItem = (sectionIndex: number, itemIndex: number, direction: -1 | 1) => setLog((draft) => {
    const items = draft.sections[sectionIndex].items;
    const target = itemIndex + direction;
    if (target < 0 || target >= items.length) return;
    const [item] = items.splice(itemIndex, 1);
    items.splice(target, 0, item);
  }, true);

  const moveItemToSection = (sectionIndex: number, itemIndex: number, targetSectionIndex: number) => setLog((draft) => {
    if (sectionIndex === targetSectionIndex) return;
    const sourceItems = draft.sections[sectionIndex].items;
    const [item] = sourceItems.splice(itemIndex, 1);
    draft.sections[targetSectionIndex].items.push(item);
  }, true);

  const clearBulletDropTarget = (session: BulletDragSession) => {
    session.targetElement?.classList.remove("dragTarget-before", "dragTarget-after");
    session.targetElement = null;
    session.target = null;
  };

  const readBulletLocation = (element: Element | null): BulletDragLocation | null => {
    if (!(element instanceof HTMLElement)) return null;
    const sectionIndex = Number(element.dataset.sectionIndex);
    const itemIndex = Number(element.dataset.itemIndex);
    if (!Number.isInteger(sectionIndex) || !Number.isInteger(itemIndex)) return null;
    return { sectionIndex, itemIndex };
  };

  const getBulletDropTarget = (clientX: number, clientY: number): { target: BulletDropTarget; element: HTMLElement | null } | null => {
    const hit = document.elementFromPoint(clientX, clientY);
    const itemElement = hit?.closest<HTMLElement>(".itemEditor[data-section-index][data-item-index]");
    if (itemElement) {
      const location = readBulletLocation(itemElement);
      if (!location) return null;
      const rect = itemElement.getBoundingClientRect();
      return {
        target: {
          ...location,
          side: clientY < rect.top + rect.height / 2 ? "before" : "after"
        },
        element: itemElement
      };
    }

    const sectionElement = hit?.closest<HTMLElement>(".sectionEditor[data-section-index]");
    if (!sectionElement) return null;
    const sectionIndex = Number(sectionElement.dataset.sectionIndex);
    if (!Number.isInteger(sectionIndex)) return null;
    const itemElements = [...sectionElement.querySelectorAll<HTMLElement>(".itemEditor[data-section-index][data-item-index]")];
    if (!itemElements.length) {
      return {
        target: { sectionIndex, itemIndex: 0, side: "after" },
        element: sectionElement.querySelector<HTMLElement>(".sectionBodyInner")
      };
    }

    let closestElement = itemElements[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of itemElements) {
      const rect = candidate.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - centerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestElement = candidate;
      }
    }
    const location = readBulletLocation(closestElement);
    if (!location) return null;
    const rect = closestElement.getBoundingClientRect();
    return {
      target: {
        ...location,
        side: clientY < rect.top + rect.height / 2 ? "before" : "after"
      },
      element: closestElement
    };
  };

  const setBulletDropTargetDom = (session: BulletDragSession, next: { target: BulletDropTarget; element: HTMLElement | null } | null) => {
    const current = session.target;
    const sameTarget = current && next &&
      current.sectionIndex === next.target.sectionIndex &&
      current.itemIndex === next.target.itemIndex &&
      current.side === next.target.side &&
      session.targetElement === next.element;
    if (sameTarget) return;
    clearBulletDropTarget(session);
    if (!next) return;
    session.target = next.target;
    session.targetElement = next.element;
    next.element?.classList.add(`dragTarget-${next.target.side}`);
  };

  const reorderBullet = (source: BulletDragLocation, target: BulletDropTarget) => {
    setLog((draft) => {
      const sourceSection = draft.sections[source.sectionIndex];
      const targetSection = draft.sections[target.sectionIndex];
      if (!sourceSection || !targetSection) return;
      const sourceItems = sourceSection.items;
      if (source.itemIndex < 0 || source.itemIndex >= sourceItems.length) return;
      let insertIndex = target.side === "after" ? target.itemIndex + 1 : target.itemIndex;
      const [item] = sourceItems.splice(source.itemIndex, 1);
      const targetItems = targetSection.items;
      if (source.sectionIndex === target.sectionIndex && source.itemIndex < insertIndex) {
        insertIndex -= 1;
      }
      insertIndex = Math.max(0, Math.min(insertIndex, targetItems.length));
      targetItems.splice(insertIndex, 0, item);
    }, true);
  };

  const finishBulletDrag = (commit: boolean) => {
    const session = bulletDragSessionRef.current;
    if (!session) return;
    bulletDragSessionRef.current = null;
    window.removeEventListener("pointermove", session.onPointerMove);
    window.removeEventListener("pointerup", session.onPointerUp);
    window.removeEventListener("pointercancel", session.onPointerCancel);
    if (session.rafId !== null) window.cancelAnimationFrame(session.rafId);
    if (session.autoScrollRafId !== null) window.cancelAnimationFrame(session.autoScrollRafId);
    clearBulletDropTarget(session);
    session.element.classList.remove("dragging");
    session.element.style.removeProperty("--drag-y");
    structuredRef.current?.classList.remove("dragActive");
    if (commit && session.target) {
      reorderBullet(session.source, session.target);
    }
  };

  const scheduleBulletDragFrame = (session: BulletDragSession) => {
    if (session.rafId !== null) return;
    session.rafId = window.requestAnimationFrame(() => {
      session.rafId = null;
      const scrollDelta = (structuredRef.current?.scrollTop ?? session.scrollStartTop) - session.scrollStartTop;
      session.element.style.setProperty("--drag-y", `${session.pointerY - session.pointerStartY + scrollDelta}px`);
      setBulletDropTargetDom(session, getBulletDropTarget(session.pointerX, session.pointerY));
    });
  };

  const runBulletAutoScroll = (session: BulletDragSession) => {
    const container = structuredRef.current;
    if (!container || bulletDragSessionRef.current !== session) return;
    const rect = container.getBoundingClientRect();
    const edgeSize = 96;
    const topDistance = session.pointerY - rect.top;
    const bottomDistance = rect.bottom - session.pointerY;
    let scrollDelta = 0;
    if (topDistance < edgeSize) {
      scrollDelta = -Math.round(((edgeSize - topDistance) / edgeSize) * 18);
    } else if (bottomDistance < edgeSize) {
      scrollDelta = Math.round(((edgeSize - bottomDistance) / edgeSize) * 18);
    }
    if (scrollDelta !== 0) {
      container.scrollTop += scrollDelta;
      scheduleBulletDragFrame(session);
    }
    session.autoScrollRafId = window.requestAnimationFrame(() => runBulletAutoScroll(session));
  };

  const beginBulletDrag = (event: React.PointerEvent<HTMLButtonElement>, location: BulletDragLocation) => {
    if (event.button !== 0) return;
    const itemElement = event.currentTarget.closest<HTMLElement>(".itemEditor");
    if (!itemElement) return;
    event.preventDefault();
    event.stopPropagation();
    finishBulletDrag(false);
    const onPointerMove = (moveEvent: PointerEvent) => {
      const activeSession = bulletDragSessionRef.current;
      if (!activeSession || moveEvent.pointerId !== activeSession.pointerId) return;
      activeSession.pointerX = moveEvent.clientX;
      activeSession.pointerY = moveEvent.clientY;
      scheduleBulletDragFrame(activeSession);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      const activeSession = bulletDragSessionRef.current;
      if (!activeSession || upEvent.pointerId !== activeSession.pointerId) return;
      finishBulletDrag(true);
    };
    const onPointerCancel = (cancelEvent: PointerEvent) => {
      const activeSession = bulletDragSessionRef.current;
      if (!activeSession || cancelEvent.pointerId !== activeSession.pointerId) return;
      finishBulletDrag(false);
    };
    const session: BulletDragSession = {
      source: location,
      element: itemElement,
      pointerId: event.pointerId,
      pointerStartY: event.clientY,
      scrollStartTop: structuredRef.current?.scrollTop ?? 0,
      pointerX: event.clientX,
      pointerY: event.clientY,
      target: null,
      targetElement: null,
      rafId: null,
      autoScrollRafId: null,
      onPointerMove,
      onPointerUp,
      onPointerCancel
    };
    bulletDragSessionRef.current = session;
    itemElement.style.setProperty("--drag-y", "0px");
    itemElement.classList.add("dragging");
    structuredRef.current?.classList.add("dragActive");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    setBulletDropTargetDom(session, getBulletDropTarget(event.clientX, event.clientY));
    session.autoScrollRafId = window.requestAnimationFrame(() => runBulletAutoScroll(session));
  };

  useEffect(() => () => {
    finishBulletDrag(false);
  }, []);

  const addBulletToSection = (sectionIndex = clampedActiveSectionIndex) => setLog((draft) => {
    if (!draft.sections[sectionIndex]) {
      draft.sections.push({ title: "GENERAL", items: [] });
    }
    draft.sections[sectionIndex].items.push({ text: "", children: [], footers: [] });
  }, true);

  const toggleSection = (sectionIndex: number, element: HTMLElement | null) => {
    const collapsed = !collapsedSectionsRef.current.has(sectionIndex);
    if (collapsed) collapsedSectionsRef.current.add(sectionIndex);
    else collapsedSectionsRef.current.delete(sectionIndex);
    element?.classList.toggle("collapsed", collapsed);
  };

  const collapseAll = () => {
    collapsedSectionsRef.current = new Set(localLog.sections.map((_section, index) => index));
    structuredRef.current?.querySelectorAll<HTMLElement>(".sectionEditor").forEach((section) => section.classList.add("collapsed"));
  };
  const expandAll = () => {
    collapsedSectionsRef.current = new Set();
    structuredRef.current?.querySelectorAll<HTMLElement>(".sectionEditor").forEach((section) => section.classList.remove("collapsed"));
  };

  return (
    <div className="structured" ref={structuredRef}>
      <div className="panelTitle">
        <div>
          <h3>Structure</h3>
          <span>Sections, bullets, and footer</span>
        </div>
        <div className="panelTitleActions splitActions">
          <span className="saveTimestamp">{lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleString()}` : "No manual save yet"}</span>
          <button className="softAction" onClick={expandAll}>Expand All</button>
          <button className="softAction" onClick={collapseAll}>Collapse All</button>
        </div>
      </div>
      <div className="structuredTop">
        <label className="updateTitleField">
          <span>Draft Title:</span>
          <MarkdownTextInput className="updateTitleInput" value={localLog.title} onChange={updateTitle} />
        </label>
        <div className="structureStats">
          <span>{localLog.sections.length} sections</span>
          <span>{localLog.sections.reduce((total, section) => total + section.items.length, 0)} bullets</span>
        </div>
      </div>
      <div className="stickyAddBar">
        <CustomSelect
          compact
          dense
          label="Add Bullet To"
          value={String(clampedActiveSectionIndex)}
          options={sectionOptions}
          onChange={(value) => setActiveSectionIndex(Number(value))}
        />
        <button className="primary addBulletButton" onClick={() => addBulletToSection()}>
          <Plus size={16} /> Add Bullet
        </button>
      </div>
      {localLog.sections.map((section, sectionIndex) => (
        <section key={`section-${sectionIndex}`} data-section-index={sectionIndex} className={collapsedSectionsRef.current.has(sectionIndex) ? "sectionEditor collapsed" : "sectionEditor"} onClick={() => setActiveSectionIndex(sectionIndex)}>
          <div className="sectionSummary">
            <div className="sectionHeading">
              <button className="collapseToggle" title="Expand or collapse section" onClick={(event) => { event.stopPropagation(); toggleSection(sectionIndex, event.currentTarget.closest(".sectionEditor")); }}>
                <ChevronDown size={16} className="collapseIcon" />
              </button>
              <MarkdownTextInput value={section.title} onChange={(value) => updateSectionTitle(sectionIndex, value)} />
              <span className="itemCount">{section.items.length} bullet{section.items.length === 1 ? "" : "s"}</span>
            </div>
            <div className="sectionActions">
              <button className="iconButton moveButton" title="Move section down" onClick={() => moveSection(sectionIndex, 1)}><ArrowDown size={15} /></button>
              <button className="iconButton moveButton" title="Move section up" onClick={() => moveSection(sectionIndex, -1)}><ArrowUp size={15} /></button>
              <button className="iconButton dangerButton" title="Delete section" onClick={() => setLog((draft) => { draft.sections.splice(sectionIndex, 1); }, true)}><X size={14} /></button>
            </div>
          </div>
          <div className="sectionBody">
            <div className="sectionBodyInner">
              {section.items.map((item, itemIndex) => (
                <div
                  className="itemEditor"
                  key={`item-${sectionIndex}-${itemIndex}`}
                  data-section-index={sectionIndex}
                  data-item-index={itemIndex}
                >
                  <div className="itemLine">
                    <button
                      className="iconButton dragHandle"
                      title="Drag bullet to reorder"
                      onPointerDown={(event) => beginBulletDrag(event, { sectionIndex, itemIndex })}
                    >
                      <GripVertical size={16} />
                    </button>
                    <span className="bulletMarker">{"\u2022"}</span>
                    <MarkdownTextInput value={item.text} onChange={(value) => updateItemText(sectionIndex, itemIndex, value)} />
                    <div className="itemTools">
                      {localLog.sections.length > 1 && (
                        <CustomSelect
                          compact
                          dense
                          value={String(sectionIndex)}
                          options={sectionOptions}
                          buttonLabel="Move to section"
                          buttonMeta={section.title}
                          onChange={(value) => moveItemToSection(sectionIndex, itemIndex, Number(value))}
                        />
                      )}
                      <button className="iconButton dangerButton" title="Delete bullet" onClick={() => setLog((draft) => { draft.sections[sectionIndex].items.splice(itemIndex, 1); }, true)}><X size={14} /></button>
                    </div>
                  </div>
                  {item.children.map((child, childIndex) => (
                    <div className="childLine" key={`child-${sectionIndex}-${itemIndex}-${childIndex}`}>
                      <span className="nestedMarker">{"\u25e6"}</span>
                      <MarkdownTextInput value={child} onChange={(value) => updateChildText(sectionIndex, itemIndex, childIndex, value)} />
                      <button className="iconButton dangerButton" title="Delete nested bullet" onClick={() => setLog((draft) => { draft.sections[sectionIndex].items[itemIndex].children.splice(childIndex, 1); }, true)}><X size={14} /></button>
                    </div>
                  ))}
                  {(item.footers ?? []).map((footer, footerIndex) => (
                    <div className="footerLine" key={`footer-${sectionIndex}-${itemIndex}-${footerIndex}`}>
                      <span className="footerMarker">-#</span>
                      <MarkdownTextInput value={footer} placeholder="Subtext / footer under this bullet" onChange={(value) => updateItemFooter(sectionIndex, itemIndex, footerIndex, value)} />
                      <button className="iconButton dangerButton" title="Delete subtext footer" onClick={() => setLog((draft) => { draft.sections[sectionIndex].items[itemIndex].footers?.splice(footerIndex, 1); }, true)}><X size={14} /></button>
                    </div>
                  ))}
                  <div className="itemAddRow">
                    <button className="subtle" onClick={() => setLog((draft) => { draft.sections[sectionIndex].items[itemIndex].children.push(""); }, true)}>
                      <ListPlus size={14} /> Nested bullet
                    </button>
                    <button className="subtle" onClick={() => setLog((draft) => {
                      draft.sections[sectionIndex].items[itemIndex].footers ??= [];
                      draft.sections[sectionIndex].items[itemIndex].footers!.push("");
                    }, true)}>
                      <Plus size={14} /> Subtext footer
                    </button>
                  </div>
                </div>
              ))}
              <button className="subtle sectionAddButton" onClick={() => addBulletToSection(sectionIndex)}>
                <Plus size={14} /> Add Bullet
              </button>
            </div>
          </div>
        </section>
      ))}
      <div className="floatingAddBullet">
        <button className="primary addBulletButton" onClick={() => addBulletToSection()}>
          <Plus size={16} /> Add Bullet
        </button>
      </div>
      <button className="primary" onClick={() => setLog((draft) => { draft.sections.push({ title: "NEW SECTION", items: [] }); }, true)}>
        <Plus size={16} /> Section
      </button>
      <label className="settingToggle footerToggle">
        <input
          type="checkbox"
          checked={hasEveryoneFooter(localLog.footer)}
          onChange={(event) => setLog((draft) => { draft.footer = setEveryoneFooter(draft.footer, event.target.checked); }, true)}
        />
        <span className="toggleBox"><Check size={18} /></span>
        <span>
          <strong>Everyone ping footer</strong>
          <small>Automatically appends <code>{everyoneFooter}</code> at the bottom of the update log.</small>
        </span>
      </label>
      <label className="footerField">
        <span>
          <strong>Bottom footer text</strong>
          <small>Custom final subtext lines. The @everyone toggle above writes the common Discord ping for you.</small>
        </span>
        <textarea className="footerTextarea" value={localLog.footer} onChange={(event) => updateBottomFooter(event.target.value)} />
      </label>
    </div>
  );
});

const Preview = React.memo(function Preview({
  rawMarkdown,
  splitResult,
  emojiMap
}: {
  rawMarkdown: string;
  splitResult: ReturnType<typeof splitDiscordMessages>;
  emojiMap: Map<string, string>;
}) {
  const [mode, setMode] = useState<"desktop" | "mobile" | "raw">("desktop");
  const previewTime = useMemo(() => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), []);
  const parts = splitResult.chunks.length > 0 ? splitResult.chunks : [rawMarkdown];

  return (
    <div className="previewWrap">
      <div className="previewToolbar">
        <div className="toolbarGroup">
          <span>Preview</span>
          <div className="segmented">
            <button className={mode === "desktop" ? "active" : ""} onClick={() => setMode("desktop")}>Desktop</button>
            <button className={mode === "mobile" ? "active" : ""} onClick={() => setMode("mobile")}>Mobile</button>
            <button className={mode === "raw" ? "active" : ""} onClick={() => setMode("raw")}>Raw</button>
          </div>
        </div>
        <span>{rawMarkdown.length.toLocaleString()} chars, {parts.length} message{parts.length === 1 ? "" : "s"}</span>
      </div>
      {mode === "raw" ? (
        <textarea readOnly value={rawMarkdown} className="rawExport standalone" />
      ) : (
        <div className={mode === "mobile" ? "discordSurface mobileMode" : "discordSurface"}>
          <div className="discordChannelHeader"># update-log</div>
          {parts.map((part, index) => (
            <div className="discordMessage" key={`${index}-${part.length}`}>
              <img className="discordAvatar" src="/bird-profile.png" alt="Bird profile" />
              <div className="discordMessageBody">
                <div className="discordMeta">
                  <strong>Bird</strong>
                  <span>Today at {previewTime}{parts.length > 1 ? `, part ${index + 1}/${parts.length}` : ""}</span>
                </div>
                <div className="discordPreview"><DiscordMarkdown raw={part} emojiMap={emojiMap} /></div>
              </div>
            </div>
          ))}
        </div>
      )}
      {splitResult.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
    </div>
  );
});

const DiscordMarkdown = React.memo(function DiscordMarkdown({ raw, emojiMap }: { raw: string; emojiMap: Map<string, string> }) {
  const nodes = useMemo(() => {
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const nextNodes: React.ReactNode[] = [];
    let codeLines: string[] = [];
    let inCode = false;

    const flushCode = (key: number) => {
      if (codeLines.length) {
        nextNodes.push(<pre key={`code-${key}`}><code>{codeLines.join("\n")}</code></pre>);
        codeLines = [];
      }
    };

    lines.forEach((line, index) => {
      if (line.trim().startsWith("```")) {
        if (inCode) {
          inCode = false;
          flushCode(index);
        } else {
          inCode = true;
        }
        return;
      }
      if (inCode) {
        codeLines.push(line);
        return;
      }
      if (line.trim() === "") {
        nextNodes.push(<div className="blankLine" key={index} />);
        return;
      }
      if (line.startsWith("## ") && !line.startsWith("### ")) {
        nextNodes.push(<h2 key={index}>{renderInline(line.slice(3), emojiMap)}</h2>);
        return;
      }
      if (line.startsWith("### ")) {
        nextNodes.push(<h3 key={index}>{renderInline(line.slice(4), emojiMap)}</h3>);
        return;
      }
      if (line.startsWith("-# ")) {
        nextNodes.push(<p className="subtext" key={index}>{renderInline(line.slice(3), emojiMap)}</p>);
        return;
      }
      if (line.startsWith("  -# ")) {
        nextNodes.push(<p className="subtext nestedSubtext" key={index}>{renderInline(line.slice(5), emojiMap)}</p>);
        return;
      }
      if (line.startsWith("> ")) {
        nextNodes.push(<blockquote key={index}>{renderInline(line.slice(2), emojiMap)}</blockquote>);
        return;
      }
      if (line.startsWith("  - ")) {
        nextNodes.push(<div className="previewBullet nested" key={index}><span>{"\u25e6"}</span><p>{renderInline(line.slice(4), emojiMap)}</p></div>);
        return;
      }
      if (line.startsWith("- ")) {
        nextNodes.push(<div className="previewBullet" key={index}><span>{"\u2022"}</span><p>{renderInline(line.slice(2), emojiMap)}</p></div>);
        return;
      }
      nextNodes.push(<p key={index}>{renderInline(line, emojiMap)}</p>);
    });
    flushCode(lines.length + 1);
    return nextNodes;
  }, [raw, emojiMap]);

  return <>{nodes}</>;
});

function renderInline(text: string, emojiMap: Map<string, string>): React.ReactNode[] {
  const pattern = /(`[^`]+`|\|\|[^|]+\|\||\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(...renderPlainTextWithEmojis(text.slice(lastIndex, match.index), emojiMap));
    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith("`")) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("||")) parts.push(<span className="spoiler" key={key}>{renderInline(token.slice(2, -2), emojiMap)}</span>);
    else if (token.startsWith("**")) parts.push(<strong key={key}>{renderInline(token.slice(2, -2), emojiMap)}</strong>);
    else if (token.startsWith("__")) parts.push(<u key={key}>{renderInline(token.slice(2, -2), emojiMap)}</u>);
    else if (token.startsWith("~~")) parts.push(<s key={key}>{renderInline(token.slice(2, -2), emojiMap)}</s>);
    else if (token.startsWith("*")) parts.push(<em key={key}>{renderInline(token.slice(1, -1), emojiMap)}</em>);
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      parts.push(link ? <a key={key} href={link[2]} target="_blank" rel="noreferrer">{renderInline(link[1], emojiMap)}</a> : token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(...renderPlainTextWithEmojis(text.slice(lastIndex), emojiMap));
  return parts;
}

function EmojiPanel({
  settings,
  onChange,
  onCopy
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const catalog = useMemo(() => buildEmojiCatalog(settings.customEmojis), [settings.customEmojis]);
  const genericEntries = catalog.filter((entry) => entry.source === "generic");
  const customEntries = catalog.filter((entry) => entry.source === "custom");
  const cleanedName = sanitizeEmojiName(name);
  const previewToken = cleanedName ? emojiToken(cleanedName) : ":Name:";

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const selectFile = (nextFile: File | undefined | null) => {
    setFile(nextFile ?? null);
    setError("");
  };

  const addCustomEmoji = async () => {
    const nextName = cleanedName;
    if (!nextName || !file) {
      setError("Add a name and upload an image.");
      return;
    }
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      setError("Use a PNG, JPG, GIF, or WEBP image.");
      return;
    }
    if (file.size > 2_000_000) {
      setError("Emoji image must be 2 MB or smaller.");
      return;
    }
    try {
      setIsUploading(true);
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await api<UploadEmojiResponse>("/api/emojis/upload", {
        method: "POST",
        body: JSON.stringify({ name: nextName, mimeType: file.type, dataUrl })
      });
      const withoutDuplicate = settings.customEmojis.filter((entry) => entry.name.toLowerCase() !== nextName.toLowerCase());
      onChange({ ...settings, customEmojis: [...withoutDuplicate, uploaded.emoji] });
      setName("");
      selectFile(null);
      setError("");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Emoji upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  const removeCustomEmoji = (targetName: string) => {
    onChange({
      ...settings,
      customEmojis: settings.customEmojis.filter((entry) => entry.name.toLowerCase() !== targetName.toLowerCase())
    });
  };

  const EmojiTile = ({ entry, removable = false }: { entry: EmojiCatalogEntry; removable?: boolean }) => {
    const token = emojiToken(entry.name);
    return (
      <div className="emojiTile">
        <button className="emojiTokenButton" onClick={() => onCopy(token, `${token} copied`)}>
          <EmojiVisual value={entry.emoji} token={token} className="emojiPreview" />
          <span>
            <strong>{entry.name}</strong>
            <code>{token}</code>
          </span>
        </button>
        {removable && (
          <button className="iconButton dangerButton" title={`Remove ${entry.name}`} onClick={() => removeCustomEmoji(entry.name)}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="emojiPanel">
      <div className="panelTitle">
        <div>
          <h3>Custom Emojis</h3>
          <span>Uploaded images rendered from Discord-style tokens</span>
        </div>
      </div>
      <div className="emojiComposer">
        <div className="emojiUploadFields">
          <label>Name
            <input value={name} onChange={(event) => setName(sanitizeEmojiName(event.target.value))} placeholder="Star" />
          </label>
          <div className="emojiTokenPreview">
            <span>Token</span>
            <code>{previewToken}</code>
          </div>
        </div>
        <button
          type="button"
          className={`emojiDropZone${previewUrl ? " hasPreview" : ""}${isDraggingFile ? " dragging" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDraggingFile(true);
          }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDraggingFile(false);
            selectFile(event.dataTransfer.files[0]);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
          {previewUrl ? (
            <img src={previewUrl} alt="Custom emoji preview" />
          ) : (
            <span className="emojiDropIcon"><SmilePlus size={22} /></span>
          )}
          <span>
            <strong>{file ? file.name : "Upload emoji image"}</strong>
            <small>{file ? `${Math.ceil(file.size / 1024)} KB selected` : "PNG, JPG, GIF, or WEBP"}</small>
          </span>
        </button>
        <button className="primary emojiUploadButton" disabled={isUploading} onClick={addCustomEmoji}>
          <Plus size={15} /> {isUploading ? "Uploading..." : "Upload"}
        </button>
      </div>
      {error && <div className="warning">{error}</div>}
      <h3>Custom</h3>
      <div className="emojiGrid">
        {customEntries.length
          ? customEntries.map((entry) => <EmojiTile key={`custom-${entry.name}`} entry={entry} removable />)
          : <div className="emptyState">No custom emojis yet.</div>}
      </div>
      <h3>Generic</h3>
      <div className="emojiGrid">
        {genericEntries.map((entry) => <EmojiTile key={`generic-${entry.name}`} entry={entry} />)}
      </div>
    </div>
  );
}

const SplitPanel = React.memo(function SplitPanel({
  result,
  onCopy,
  rawMarkdown,
  settings,
  onTogglePartHeaders
}: {
  result: ReturnType<typeof splitDiscordMessages>;
  onCopy: (text: string, label: string) => void;
  rawMarkdown: string;
  settings?: AppSettings;
  onTogglePartHeaders: (enabled: boolean) => void;
}) {
  const splitIntoMultipleParts = result.chunks.length > 1;
  const exportJson = () => {
    const structured = parseUpdateLog(rawMarkdown).log;
    download("update-log-draft.json", JSON.stringify({ rawMarkdown, structured }, null, 2));
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    const payload = JSON.parse(await file.text());
    await api("/api/import", {
      method: "POST",
      body: JSON.stringify({
        name: payload.name ?? payload.structured?.title ?? "Imported Update",
        rawMarkdown: payload.rawMarkdown,
        structured: payload.structured
      })
    });
    window.location.reload();
  };

  return (
    <div className="splitPanel">
      <div className="panelTitle">
        <div>
          <h3>Discord Splitter</h3>
          <span>Message parts and exports</span>
        </div>
      </div>
      <div className="stats">
        <span>Total {result.totalCharacters}</span>
        <span>Limit {result.limit}</span>
        <span>{result.chunks.length} message{result.chunks.length === 1 ? "" : "s"}</span>
      </div>
      <label className="settingToggle messageToggle">
        <input
          type="checkbox"
          checked={!!settings?.continuationHeaders}
          onChange={(event) => onTogglePartHeaders(event.target.checked)}
        />
        <span className="toggleBox"><Check size={18} /></span>
        <span>
          <strong>Part headers</strong>
          <small>
            {splitIntoMultipleParts
              ? `Adds big PART 1/${result.chunks.length} headings to each split Discord message.`
              : "Ready to add PART headings only if this log becomes more than one message."}
          </small>
        </span>
      </label>
      <div className="exportButtons">
        <button onClick={() => onCopy(rawMarkdown, "Full log copied")}><Clipboard size={15} /> Copy full</button>
        <button onClick={() => onCopy(result.chunks.join("\n\n---\n\n"), "All parts copied")}><Copy size={15} /> Copy all</button>
        <button onClick={() => download("update-log.md", rawMarkdown)}><Download size={15} /> .md</button>
        <button onClick={() => download("update-log.txt", rawMarkdown)}><Download size={15} /> .txt</button>
        <button onClick={exportJson}><Download size={15} /> JSON</button>
        <label className="fileButton">Import JSON<input type="file" accept="application/json,.json" onChange={(event) => importJson(event.target.files?.[0])} /></label>
      </div>
      {result.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      {result.chunks.map((chunk, index) => (
        <article className="chunk" key={index}>
          <header><strong>Part {index + 1}</strong><span>{chunk.length} chars</span><button onClick={() => onCopy(chunk, `Part ${index + 1} copied`)}><Copy size={14} /></button></header>
          <pre>{chunk}</pre>
        </article>
      ))}
    </div>
  );
});

function AiPanel({
  draftId,
  rawMarkdown,
  structured,
  customEmojis,
  onApply
}: {
  draftId: string;
  rawMarkdown: string;
  structured: UpdateLog;
  customEmojis: CustomEmoji[];
  onApply: (log: UpdateLog) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [modelMode, setModelMode] = useState("default");
  const [customModel, setCustomModel] = useState("");
  const [proposal, setProposal] = useState<(AiEditResponse & { updatedMarkdown: string }) | null>(null);
  const codexStatus = useQuery({ queryKey: ["codex-status"], queryFn: () => api<any>("/api/codex/status"), ...codexStatusQueryOptions });
  const codexDefaultModel = codexStatus.data?.defaultModel || "CLI configured model";
  const modelOptions: SelectOption[] = [
    { value: "default", label: "Use Codex default", meta: `Uses ${displayModelName(codexDefaultModel)}` },
    { value: "gpt-5.5", label: "GPT-5.5", meta: "Newest listed option" },
    { value: "gpt-5.4", label: "GPT-5.4", meta: "Fallback option" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Spark", meta: "Fast coding option" },
    { value: "custom", label: "Custom model", meta: "Manual name" }
  ];
  const mutation = useMutation({
    mutationFn: () => api<AiEditResponse & { updatedMarkdown: string }>("/api/codex/edit", {
      method: "POST",
      body: JSON.stringify({
        draftId,
        rawMarkdown,
        draft: structured,
        instruction,
        customEmojis,
        model: modelMode === "custom" ? customModel : modelMode
      })
    }),
    onMutate: () => {
      setProposal(null);
    },
    onSuccess: setProposal
  });
  const diff = proposal ? diffLines(rawMarkdown, proposal.updatedMarkdown) : [];
  const updateInstruction = (value: string) => {
    setInstruction(value);
    setProposal(null);
  };
  const updateModelMode = (value: string) => {
    setModelMode(value);
    setProposal(null);
  };
  const updateCustomModel = (value: string) => {
    setCustomModel(value);
    setProposal(null);
  };

  return (
    <div className="aiPanel">
      <div className="aiHero">
        <div className="aiOrb"><Bot size={21} /></div>
        <div>
          <h3>Codex Edit</h3>
          <p>Local CLI proposal</p>
        </div>
      </div>
      <div className="aiComposer">
        <label>Instruction
          <textarea value={instruction} onChange={(event) => updateInstruction(event.target.value)} placeholder="Polish this log, shorten a section, reorganize bullets, or apply notes without inventing changes." />
        </label>
        <div className="modelGrid">
          <CustomSelect label="Model" value={modelMode} options={modelOptions} onChange={updateModelMode} />
          {modelMode === "custom" && <label>Custom<input value={customModel} onChange={(event) => updateCustomModel(event.target.value)} placeholder="model-name" /></label>}
        </div>
        <button className="primary askButton" disabled={!instruction || mutation.isPending} onClick={() => mutation.mutate()}>
          <Bot size={16} /> {mutation.isPending ? "Asking Codex..." : "Ask Codex"}
        </button>
      </div>
      {mutation.error && <div className="warning">{mutation.error.message}</div>}
      {mutation.isPending && (
        <div className="aiLoading">
          <div className="pulseDot" />
          <span>Codex is drafting a proposed edit.</span>
        </div>
      )}
      {proposal && (
        <div className="proposal">
          <div className="proposalHeader">
            <div>
              <span>Proposal</span>
              <h3>{proposal.summary}</h3>
            </div>
            <span>{proposal.updatedMarkdown.length.toLocaleString()} chars</span>
          </div>
          <div className="diff">
            {diff.map((part, index) => <pre key={index} className={part.added ? "added" : part.removed ? "removed" : ""}>{part.value}</pre>)}
          </div>
          <div className="proposalActions">
            <button className="primary" onClick={() => {
              onApply(proposal.updatedLog);
              setProposal(null);
            }}><Check size={15} /> Apply</button>
            <button onClick={() => setProposal(null)}><X size={15} /> Reject</button>
            <button onClick={() => mutation.mutate()}><RefreshCw size={15} /> Regenerate</button>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryPanel({ draftId }: { draftId: string }) {
  const queryClient = useQueryClient();
  const versions = useQuery({ queryKey: ["versions", draftId], queryFn: () => api<VersionsResponse>(`/api/drafts/${draftId}/versions`) });
  const restore = useMutation({
    mutationFn: (id: string) => api<DraftResponse>(`/api/versions/${id}/restore`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  return (
    <div className="historyPanel">
      <div className="panelTitle">
        <div>
          <h3>Version History</h3>
          <span>Saved draft snapshots</span>
        </div>
      </div>
      {versions.data?.versions.map((version) => (
        <article className="historyItem" key={version.id}>
          <strong>{version.label}</strong>
          <span>{new Date(version.createdAt).toLocaleString()}</span>
          <button onClick={() => restore.mutate(version.id)}>Restore</button>
        </article>
      ))}
    </div>
  );
}

function SettingsPanel({ settings }: { settings: AppSettings }) {
  const [local, setLocal] = useState(settings);
  const [statusActionText, setStatusActionText] = useState("");
  const hasLoadedSettings = useRef(false);
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["codex-status"], queryFn: () => api<any>("/api/codex/status"), ...codexStatusQueryOptions });
  const codexDefaultModel = status.data?.defaultModel || "CLI configured model";
  const modelOptions: SelectOption[] = [
    { value: "gpt-5.4", label: "GPT-5.4", meta: "Recommended for this CLI" },
    { value: "gpt-5.5", label: "GPT-5.5", meta: "Requires latest Codex" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Spark", meta: "Fast coding option" },
    { value: "default", label: "Use Codex default", meta: `Uses ${displayModelName(codexDefaultModel)}` },
    { value: "custom", label: "Custom model", meta: "Manual name" }
  ];
  const limitModeOptions: SelectOption[] = [
    { value: "normal", label: "Normal Discord", meta: "2000 characters" },
    { value: "nitro", label: "Nitro", meta: "4000 characters" },
    { value: "webhook", label: "Webhook/API", meta: "2000 characters" },
    { value: "custom", label: "Custom", meta: `${local.customLimit} characters` }
  ];
  const save = useMutation({
    mutationFn: () => api<SettingsResponse>("/api/settings", { method: "PUT", body: JSON.stringify(local) }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      queryClient.invalidateQueries({ queryKey: ["codex-status"] });
    }
  });
  const updateCodex = useMutation({
    mutationFn: () => api<{ ok: boolean; output: string }>("/api/codex/update", { method: "POST" }),
    onSuccess: () => status.refetch()
  });
  const statusRefreshing = status.isLoading || status.isFetching;
  const statusPending = status.isLoading || (status.isFetching && !status.data);
  const needsCodexUpdate = typeof status.data?.smokeTestError === "string" && status.data.smokeTestError.includes("requires a newer version of Codex");
  const codexReady = !!status.data?.installed && !!status.data?.loggedIn && !!status.data?.smokeTest;
  const copySetupCommand = async (command: string) => {
    await copyText(command);
    setStatusActionText(`Copied ${command}`);
    window.setTimeout(() => setStatusActionText(""), 1300);
  };

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  useEffect(() => {
    if (!hasLoadedSettings.current) {
      hasLoadedSettings.current = true;
      return;
    }
    const timeout = window.setTimeout(() => save.mutate(), 650);
    return () => window.clearTimeout(timeout);
  }, [local]);

  return (
    <div className="settingsPanel">
      <div className="panelTitle">
        <div>
          <h3>Settings</h3>
          <span>Codex, splitting, and autosave</span>
        </div>
      </div>
      <h3>Codex Setup</h3>
      <StatusRow
        pending={statusPending}
        label="Installed"
        ok={!!status.data?.installed}
        detail={status.data?.version || "npm i -g @openai/codex"}
        actionLabel="Copy install"
        onAction={() => copySetupCommand("npm i -g @openai/codex")}
      />
      <StatusRow
        pending={statusPending}
        label="Logged in"
        ok={!!status.data?.loggedIn}
        detail={status.data?.loginStatus || "codex login"}
        actionLabel="Copy login"
        onAction={() => copySetupCommand("codex login")}
      />
      <StatusRow
        pending={statusPending}
        label="Exec ready"
        ok={!!status.data?.smokeTest}
        detail={status.data?.smokeTestError || "read-only JSON exec"}
        actionLabel="Refresh"
        onAction={() => status.refetch()}
      />
      <div className="settingsActions">
        <button className={statusRefreshing ? "refreshButton loading" : "refreshButton"} disabled={statusRefreshing} onClick={() => status.refetch()}>
          <RefreshCw size={15} /> {statusRefreshing ? "Refreshing..." : "Refresh status"}
        </button>
        {statusPending ? (
          <button className="upToDateButton" disabled>
            <RefreshCw className="spinIcon" size={15} /> Checking Codex...
          </button>
        ) : codexReady ? (
          <button className="upToDateButton" disabled>
            <Check size={15} /> Codex CLI up to date
          </button>
        ) : (
          <button
            className="primary"
            disabled={updateCodex.isPending || !needsCodexUpdate}
            onClick={() => updateCodex.mutate()}
          >
            <RefreshCw size={15} /> {updateCodex.isPending ? "Updating Codex..." : needsCodexUpdate ? "Update Codex CLI" : "Codex update unavailable"}
          </button>
        )}
      </div>
      {statusActionText && <div className="settingsSaveHint">{statusActionText}</div>}
      {updateCodex.error && <div className="warning">{updateCodex.error.message}</div>}
      {updateCodex.data?.ok && <div className="success">Codex CLI update finished.</div>}
      <h3>Defaults</h3>
      <CustomSelect
        label="Codex model"
        value={local.selectedModelMode}
        options={modelOptions}
        onChange={(value) => setLocal({ ...local, selectedModelMode: value as AppSettings["selectedModelMode"] })}
      />
      {local.selectedModelMode === "custom" && <label>Custom model<input value={local.customModel} onChange={(event) => setLocal({ ...local, customModel: event.target.value })} /></label>}
      <CustomSelect
        label="Character limit mode"
        value={local.characterLimitMode}
        options={limitModeOptions}
        onChange={(value) => setLocal({ ...local, characterLimitMode: value as AppSettings["characterLimitMode"] })}
      />
      <label>Custom limit<input type="number" value={local.customLimit} onChange={(event) => setLocal({ ...local, customLimit: Number(event.target.value) })} /></label>
      <label className="settingToggle">
        <input
          type="checkbox"
          checked={hasEveryoneFooter(local.defaultFooter)}
          onChange={(event) => setLocal({ ...local, defaultFooter: setEveryoneFooter(local.defaultFooter, event.target.checked) })}
        />
        <span className="toggleBox"><Check size={18} /></span>
        <span>
          <strong>Default everyone footer</strong>
          <small>New drafts include <code>{everyoneFooter}</code> automatically when this is enabled.</small>
        </span>
      </label>
      <label>Autosave ms<input type="number" value={local.autosaveIntervalMs} onChange={(event) => setLocal({ ...local, autosaveIntervalMs: Number(event.target.value) })} /></label>
      <button className="primary" onClick={() => save.mutate()}><Save size={15} /> {save.isPending ? "Saving..." : "Save settings"}</button>
      <div className="settingsSaveHint">{save.isPending ? "Auto-saving settings..." : "Settings auto-save after changes."}</div>
    </div>
  );
}

function StatusRow({
  label,
  ok,
  detail,
  pending = false,
  actionLabel,
  onAction
}: {
  label: string;
  ok: boolean;
  detail: string;
  pending?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const needsAction = !pending && !ok && actionLabel && onAction;
  return (
    <div className={pending ? "status pending" : ok ? "status ok" : "status bad"}>
      <span>{pending ? "Checking" : ok ? "OK" : "Needs setup"}</span>
      <strong>{label}</strong>
      <code>{pending ? "Checking status..." : detail}</code>
      {needsAction ? <button className="statusAction" onClick={onAction}>{actionLabel}</button> : <span className="statusActionSpacer" />}
    </div>
  );
}

const rootElement = document.getElementById("root")!;
const hotWindow = window as typeof window & { __updateLogEditorRoot?: ReturnType<typeof createRoot> };
hotWindow.__updateLogEditorRoot ??= createRoot(rootElement);
hotWindow.__updateLogEditorRoot.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
