import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { aiEditResponseSchema, genericEmojiCatalog, type CustomEmoji, type UpdateLog } from "../shared/types";
import { codexOutputJsonSchema } from "../shared/codexSchema";
import { serializeUpdateLog } from "../shared/markdown";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDir = join(rootDir, "data");
const schemaPath = join(schemaDir, "codex-edit-schema.json");

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runCommand(command: string, args: string[], input?: string, timeoutMs = 120000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: rootDir,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      settled = true;
      reject(new Error("Codex command timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) {
        child.kill();
        reject(new Error("Codex stdout exceeded safety limit."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) {
        stderr = stderr.slice(-200_000);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && command === "codex") {
    const candidates = [
      process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : "",
      join(dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js")
    ].filter(Boolean);
    const script = candidates.find((candidate) => existsSync(candidate));
    if (script) {
      return { command: process.execPath, args: [script, ...args] };
    }
  }
  if (process.platform === "win32" && command === "npm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
  }
  return { command, args };
}

function sanitize(value: string): string {
  const cleaned = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[A-Z]:\\Users\\[^\\\s]+\\.codex[^\s]*/gi, "[codex-auth-redacted]")
    .slice(0, 4000);
  const modelUpgrade = cleaned.match(/The '[^']+' model requires a newer version of Codex\.[^"}]*/);
  if (modelUpgrade) {
    return `Codex exec failed: ${modelUpgrade[0]}`;
  }
  return cleaned;
}

export function validateModelName(model: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(model);
}

export async function getCodexStatus(selectedModel: string) {
  const status = {
    installed: false,
    version: "",
    loggedIn: false,
    loginStatus: "",
    supports: {
      readOnlySandbox: false,
      json: false,
      model: false,
      outputSchema: false,
      approvalNever: false
    },
    smokeTest: false,
    smokeTestError: "",
    selectedModel,
    defaultModel: getCodexDefaultModel(),
    installCommand: "npm i -g @openai/codex",
    loginCommand: "codex login",
    error: ""
  };

  try {
      const version = await runCommand("codex", ["--version"], undefined, 10000);
    status.installed = version.code === 0;
    status.version = version.stdout.trim() || version.stderr.trim();
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Codex CLI is unavailable.";
    return status;
  }

  try {
    const login = await runCommand("codex", ["login", "status"], undefined, 10000);
    status.loggedIn = login.code === 0 && /logged in/i.test(login.stdout + login.stderr);
    status.loginStatus = (login.stdout || login.stderr).trim();
  } catch {
    status.loggedIn = false;
  }

  try {
    const help = await runCommand("codex", ["-a", "never", "exec", "--sandbox", "read-only", "--json", "--help"], undefined, 10000);
    const output = `${help.stdout}\n${help.stderr}`;
    status.supports.readOnlySandbox = output.includes("--sandbox");
    status.supports.json = output.includes("--json");
    status.supports.model = output.includes("--model");
    status.supports.outputSchema = output.includes("--output-schema");
    status.supports.approvalNever = help.code === 0;
  } catch {
    status.supports.approvalNever = false;
  }

  if (status.installed && status.loggedIn && status.supports.readOnlySandbox && status.supports.json) {
    try {
      const smokeArgs = ["-a", "never", "exec", "--sandbox", "read-only", "--json"];
      if (selectedModel && selectedModel !== "default" && validateModelName(selectedModel)) {
        smokeArgs.push("-m", selectedModel);
      }
      smokeArgs.push("-");
      const smoke = await runCommand(
        "codex",
        smokeArgs,
        "Return JSON only: {\"ok\":true}",
        60000
      );
      status.smokeTest = smoke.code === 0;
      if (!status.smokeTest) {
        status.smokeTestError = sanitize(smoke.stderr || smoke.stdout || "Smoke test did not return ok.");
      }
    } catch (error) {
      status.smokeTestError = error instanceof Error ? sanitize(error.message) : "Smoke test failed.";
    }
  }
  return status;
}

function getCodexDefaultModel(): string {
  try {
    const configPath = process.platform === "win32" && process.env.USERPROFILE
      ? join(process.env.USERPROFILE, ".codex", "config.toml")
      : join(process.env.HOME ?? "", ".codex", "config.toml");
    if (!existsSync(configPath)) return "";
    const config = readFileSync(configPath, "utf8");
    const match = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export async function updateCodexCli() {
  const result = await runCommand("npm", ["install", "-g", "@openai/codex"], undefined, 180000);
  if (result.code !== 0) {
    throw new Error(sanitize(result.stderr || result.stdout || `npm exited with code ${result.code}.`));
  }
  return {
    ok: true,
    output: sanitize(`${result.stdout}\n${result.stderr}`).slice(-4000)
  };
}

export function extractFinalJson(stdout: string): unknown {
  let lastMessage = "";
  let lastNonEventLine = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastMessage = event.item.text;
        continue;
      }
      const message = event.message ?? event.msg ?? event.output ?? event.text;
      if (typeof message === "string") {
        lastMessage = message;
      }
      if (event.type === "agent_message" && typeof event.message === "string") {
        lastMessage = event.message;
      }
      if (event.type === "task_complete" && typeof event.last_message === "string") {
        lastMessage = event.last_message;
      }
    } catch {
      lastNonEventLine = line;
    }
  }

  const trimmed = (lastMessage || lastNonEventLine).trim();
  if (!trimmed) {
    throw new Error("Codex returned no assistant message.");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}$/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Codex returned malformed JSON.");
  }
}

export async function runCodexEdit(input: {
  draft: UpdateLog;
  rawMarkdown: string;
  instruction: string;
  customEmojis?: CustomEmoji[];
  model?: string;
}) {
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(schemaPath, JSON.stringify(codexOutputJsonSchema, null, 2), "utf8");

  const args = ["-a", "never", "exec", "--sandbox", "read-only", "--json", "--output-schema", schemaPath];
  if (input.model) {
    if (!validateModelName(input.model)) {
      throw new Error("Invalid model name.");
    }
    args.push("-m", input.model);
  }
  args.push("-");

  const emojiCatalog = formatEmojiCatalog(input.customEmojis ?? []);
  const prompt = `You are editing a Discord game update log. Return valid JSON only, matching the provided schema.

Rules:
- Preserve the user's patch-note style.
- Do not remove existing content unless explicitly asked.
- Do not invent game changes.
- Preserve Discord Markdown.
- Emoji aliases are Discord-style text tokens, for example :Star: or :Heart:.
- Use available emoji aliases when the user asks to add emojis. Keep aliases in text as :Name: tokens; the app preview renders them as emoji.
- Preserve existing unknown emoji aliases exactly as typed.
- Keep title as ## heading.
- Keep sections as ### headings.
- Keep top-level bullets as "- ".
- Keep nested bullets as two-space indented "- ".
- Keep the footer at the end unless asked to change it.
- AI editing must only propose draft changes.

Available emoji aliases:
${emojiCatalog}

User instruction:
${input.instruction}

Current structured draft JSON:
${JSON.stringify(input.draft, null, 2)}

Current raw Markdown:
${input.rawMarkdown}

Respond with:
{"summary":"Short explanation of changes","updatedLog":{"title":"...","sections":[{"title":"...","items":[{"text":"...","children":["..."],"footers":[]}]}],"footer":"..."}}`;

  const result = await runCommand("codex", args, prompt, 180000);
  if (result.code !== 0) {
    throw new Error(sanitize(result.stderr || result.stdout || `Codex exited with code ${result.code}.`));
  }
  const parsed = aiEditResponseSchema.parse(extractFinalJson(result.stdout));
  return {
    ...parsed,
    updatedMarkdown: serializeUpdateLog(parsed.updatedLog)
  };
}

function formatEmojiCatalog(customEmojis: CustomEmoji[]): string {
  const entries = new Map<string, string>();
  for (const entry of genericEmojiCatalog) {
    entries.set(entry.name.toLowerCase(), `:${entry.name}: = ${entry.emoji}`);
  }
  for (const entry of customEmojis) {
    entries.set(entry.name.toLowerCase(), `:${entry.name}: = ${entry.emoji}`);
  }
  return [...entries.values()].join("\n");
}
