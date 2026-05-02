const [, , maybeDate] = process.argv;
const date = maybeDate || new Date().toISOString().slice(0, 10);
const response = await fetch(`http://127.0.0.1:4317/api/codex/intake/daily?date=${encodeURIComponent(date)}`);
const body = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(body.error ?? `${response.status} ${response.statusText}`);
  process.exit(1);
}

console.log(`Codex update-log additions for ${body.date}: ${body.count}`);
for (const entry of body.entries) {
  console.log(`- [${entry.draftName} / ${entry.sectionTitle}] ${entry.bulletText}`);
  for (const child of entry.children) {
    console.log(`  - ${child}`);
  }
}
