# Update Log Editor

A local Roblox update-log editor for drafting Discord-ready patch notes. It combines raw Markdown editing, a structured section-and-bullet editor, Discord-style previews, message splitting, local draft/version storage, custom emoji uploads, and optional Codex-powered edit helpers.

## Quick Start

1. Install [Node.js 20 or newer](https://nodejs.org/).
2. Clone the repo:

```powershell
git clone https://github.com/DerzeTTT/Update-Log-Editor.git
Set-Location -LiteralPath ".\Update-Log-Editor"
```

3. Install dependencies:

```powershell
npm install
```

4. Start the app:

```powershell
npm start
```

5. Open the editor at:

```text
http://127.0.0.1:5173
```

`npm start` launches both the API server and Vite frontend, opens the browser, and stops both processes after the launched editor tab closes. If the app is already running, the launcher tells you and opens the existing editor instead of starting duplicate processes.

For normal desktop use on this machine, you can also double-click:

```text
Start Update Log Editor.bat
```

Use headless mode when you want to open the browser yourself or keep the API/frontend running after tabs close:

```powershell
npm run start:headless
```

Then open `http://127.0.0.1:5173` manually.

## Editor Workflow

- Draft in the raw Markdown tab with Monaco or use the structured editor for titles, sections, bullets, nested bullets, and subtext footer lines.
- Use inline formatting controls in structured text fields for common Discord Markdown such as bold, italic, underline, strike, spoiler, links, and inline code.
- Reorder sections and bullets with the drag handles. Bullet dragging is pointer-driven, scroll-aware, and commits the reorder only after release.
- Use Preview to inspect the same draft in Discord-like desktop, mobile, or raw modes.
- Use Emojis to copy built-in aliases such as `:Star:` or upload local PNG, JPG, GIF, or WEBP custom emoji images. Uploaded images are stored under `data/custom-emojis/` and preview as inline images.
- Use Messages to split a long log into Discord-sized chunks. Supported limits are normal, Nitro, webhook, and custom. The splitter keeps whole sections together when possible, can add continuation headers, and warns when a chunk exceeds the selected limit.
- Use AI to ask Codex for proposed edits, then apply, reject, or regenerate the proposal. Custom emoji aliases are included in the edit prompt so Codex can use them as `:Name:` tokens.
- Use History to preview or restore manual versions, autosaves, and file backups.
- Use Settings to choose the Codex model, configure character limits, footer defaults, theme, autosave timing, history caps, and custom models.

## Local Drafts And Recovery

The app mirrors every draft to a plain Markdown file:

```text
Drafts/<draft-id>.md
```

You can copy the exact path from the app with `Copy .md path`. Codex or any editor can change that file directly. When the backend is running, the app checks for newer file edits and imports them back into SQLite as a `File sync` version. If the backend is closed, start the app again and it will import newer Markdown files on startup.

Drafts and app data are intentionally local. The repo ignores `Drafts/`, `data/`, `dist/`, `node_modules/`, logs, coverage, and temporary files so private drafts, SQLite databases, generated builds, uploaded emoji images, and backups do not get pushed.

Recovery layers are separate from the normal save path:

- Browser edits are mirrored into local browser recovery storage so a refresh or closed tab can restore newer unsaved text when the draft is reopened.
- The backend writes draft Markdown atomically and keeps a recovery mirror at `data/draft-backups/<draft-id>/latest.md`, plus timestamped snapshots.
- Emergency saves create autosave versions while preserving the browser recovery copy if the server save fails.
- Deleting a draft archives its last Markdown file under `data/deleted-drafts/`.
- Restoring an older version first saves the overwritten current draft as `Before restore: ...`.
- History includes file recovery actions for copying the latest backup path, copying the backup folder path, or restoring the latest backup.

## Codex Features

Install and log in to the Codex CLI before using AI features:

```powershell
npm i -g @openai/codex
codex login
```

The Settings panel checks Codex install/login status, shows the configured default model, can copy setup commands, and can run the Codex CLI update command. Built-in model choices include `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex-spark`, the CLI default, and a custom model id.

Codex-facing endpoints can retrieve drafts and saved versions:

```text
GET /api/codex/drafts/retrieve?when=yesterday&q=heian
GET /api/codex/drafts/retrieve?when=2026-05-10&source=versions&limit=5
POST /api/codex/drafts/restore
POST /api/codex/prompt
POST /api/codex/edit
POST /api/codex/intake
GET /api/codex/intake/daily?date=2026-05-12
```

`when` accepts `today`, `yesterday`, or `YYYY-MM-DD`. Retrieval responses include full Markdown and structured data for each match so Codex can recover, inspect, or restore older drafts directly.

`POST /api/codex/prompt` sends a read-only prompt to the Codex CLI. The body supports:

```json
{
  "prompt": "Tell me what the current draft looks like.",
  "model": "gpt-5.4",
  "includeDraft": true,
  "draftId": "optional-draft-id",
  "responseFormat": "text",
  "timeoutMs": 180000
}
```

Set `responseFormat` to `json` and pass `outputSchema` when you want Codex to return schema-checked JSON. Use `/api/codex/edit` for proposed update-log edits, `/api/codex/intake` for direct bullet additions, and `PUT /api/drafts/:id` to apply a full Markdown update.

## Automation Scripts

These scripts are helpers around the local API:

```powershell
npm run update-log:add -- --text="Fixed front dash hit consistency" --section="COMBAT"
npm run update-log:daily -- 2026-05-12
npm run update-log:auto -- --seed-current
npm run update-log:auto -- --repo="C:\Users\dsddr\Desktop\Limitless Project"
```

`update-log:add` posts one bullet, plus optional `--child=` details, to the latest draft or to `--draft=<draftId>`.

`update-log:daily` lists Codex intake entries for a date.

`update-log:auto` reads commits from the Roblox project, asks Codex to summarize player-facing changes, appends new bullets to the latest draft file, imports that file back through the API, and records its cursor/signatures in `data/update-log-automation-state.json`. Use `--seed-current` once to set the current commit as the starting point without adding entries.

## Useful Commands

```powershell
npm start              # start API + frontend, open browser, stop when the launched tab closes
npm run start:headless # start API + frontend without browser auto-open or tab-close shutdown
npm run api            # start only the API server on http://127.0.0.1:4317
npm run dev:server     # watch the API server during development
npm run dev:client     # start only the Vite frontend on http://127.0.0.1:5173
npm run build          # type-check and build the frontend
npm test               # run the Vitest test suite
npm run test:watch     # run Vitest in watch mode
```

Headless mode keeps running until the terminal process is stopped. When automation starts it in the background, record the process ID and stop that process tree when finished; on Windows, `taskkill /PID <pid> /T /F` stops the server and Vite child processes.
