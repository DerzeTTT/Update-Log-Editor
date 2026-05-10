# Update Log Editor

A local Roblox update-log editor for drafting Discord-ready patch notes. It gives you raw Markdown editing, a structured section-and-bullet editor, Discord-style preview, message splitting, version history, optional Codex AI edits, and custom emoji tokens.

## Easy Setup

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

With the normal `npm start` command, the editor opens in your browser and the API server plus Vite frontend stop automatically after you close the editor tab. Closing the terminal still stops both processes immediately.

For normal desktop use on this machine, you can also double-click:

```text
Start Update Log Editor.bat
```

If browser auto-open fails, you want to open the page yourself, or you want the server to keep running after browser tabs close:

```powershell
npm run start:headless
```

Then open `http://127.0.0.1:5173` manually.

## Using The Editor

- Write directly in the raw Markdown tab or use the structured editor to manage headings, sections, bullets, nested bullets, and footers.
- Drag bullet handles in the structured editor to reorder items.
- Use Preview to see the update log in a Discord-like desktop, mobile, or raw view.
- Use Emojis to copy built-in tokens such as `:Star:` or upload local custom emoji images. Custom emoji uploads are stored under `data/custom-emojis/`.
- Use Messages to split a long update log into Discord-sized chunks. The splitter keeps whole categories together when it can and warns when a category is too large for the selected limit.
- Use History to restore manual saves and spaced autosave snapshots.
- Use AI after installing and logging in to the Codex CLI with `npm i -g @openai/codex` and `codex login`.

## Local Drafts And Data

The app mirrors every draft to a plain Markdown file:

```text
Drafts/<draft-id>.md
```

You can copy the exact path from the app with `Copy .md path`. Codex or any editor can change that file directly. When the backend is running, the app checks for newer file edits and imports them back into SQLite as a `File sync` version. If the backend is closed, start the app again and it will import newer Markdown files on startup.

Drafts and app data are intentionally local. The repo ignores `Drafts/`, `data/`, `dist/`, `node_modules/`, logs, coverage, and temporary files so private drafts, SQLite databases, generated builds, and uploaded emoji images do not get pushed.

Autosave history skips duplicate snapshots and prunes older autosaves by count and storage cap. Manual saved versions are kept until you delete the draft.

The editor also keeps recovery layers outside the normal save path:

- Every browser edit is mirrored into local browser recovery storage, so a refresh or closed tab can restore newer unsaved text when the draft is reopened.
- The backend writes draft Markdown atomically and keeps an independent recovery mirror at `data/draft-backups/<draft-id>/latest.md`, plus timestamped snapshots.
- Deleting a draft archives its last Markdown file under `data/deleted-drafts/` instead of discarding the only file copy.
- The History panel includes File Recovery actions for copying the latest backup path, copying the backup folder path, or restoring the latest file backup.
- Restoring an older version first saves the overwritten current draft as a `Before restore: ...` version, so the restore operation itself cannot erase the state you had before restoring.

Codex can retrieve drafts and saved versions through the local API:

```text
GET /api/codex/drafts/retrieve?when=yesterday&q=heian
GET /api/codex/drafts/retrieve?when=2026-05-10&source=versions&limit=5
POST /api/codex/drafts/restore
POST /api/codex/prompt
```

`when` accepts `today`, `yesterday`, or `YYYY-MM-DD`. Retrieval responses include full Markdown and structured data for each match so Codex can recover or inspect an older draft directly.

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

## Useful Commands

```powershell
npm start              # start API + frontend, open the browser, stop when the editor tab closes
npm run start:headless # start API + frontend without browser auto-open or tab-close shutdown
npm run build          # type-check and build the frontend
npm test               # run the Vitest test suite
```

Headless mode keeps running until the terminal process is stopped. When automation starts it in the background, record the process ID and stop that process tree when finished; on Windows, `taskkill /PID <pid> /T /F` stops the server and Vite child processes.
