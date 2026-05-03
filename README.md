# Update Log Editor

Roblox project for editing and managing update log content.

## Direct Markdown Files

The app also mirrors every draft to a plain Markdown file:

```text
Drafts/<draft-id>.md
```

You can copy the exact path from the app with `Copy .md path`. Codex or any editor can change that file directly. When the backend is running, the app checks for newer file edits and imports them back into SQLite as a `File sync` version. If the backend is closed, start the app again and it will import newer Markdown files on startup.
