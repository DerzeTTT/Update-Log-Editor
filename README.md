# Update Log Editor

Roblox project for editing and managing update log content.

## Starting the App

The reliable way to start the editor is from this project folder:

```powershell
Set-Location -LiteralPath "D:\Update Log Editor"
npm start
```

This starts both the API server and the Vite frontend, then opens:

```text
http://127.0.0.1:5173
```

For normal desktop use, you can also double-click:

```text
Start Update Log Editor.bat
```

If Codex or another tool has trouble opening the browser automatically, start it without auto-open:

```powershell
Set-Location -LiteralPath "D:\Update Log Editor"
npm run start:headless
```

Then open `http://127.0.0.1:5173` manually. Leave the terminal window running while using the editor; closing it stops the app.

## Direct Markdown Files

The app also mirrors every draft to a plain Markdown file:

```text
Drafts/<draft-id>.md
```

You can copy the exact path from the app with `Copy .md path`. Codex or any editor can change that file directly. When the backend is running, the app checks for newer file edits and imports them back into SQLite as a `File sync` version. If the backend is closed, start the app again and it will import newer Markdown files on startup.
