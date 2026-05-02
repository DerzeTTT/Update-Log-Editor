const [, , ...args] = process.argv;

function readArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const bulletText = readArg("text") || args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
const sectionTitle = readArg("section", "EXTRA");
const draftId = readArg("draft");
const source = readArg("source", "codex");
const children = args
  .filter((arg) => arg.startsWith("--child="))
  .map((arg) => arg.slice("--child=".length))
  .filter(Boolean);

if (!bulletText) {
  console.error('Usage: npm run update-log:add -- --text="Fixed front dash hit consistency" [--section="COMBAT"] [--draft="<draftId>"] [--child="Detail"]');
  process.exit(1);
}

const response = await fetch("http://127.0.0.1:4317/api/codex/intake", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ...(draftId ? { draftId } : {}),
    sectionTitle,
    bulletText,
    children,
    source
  })
});

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(body.error ?? `${response.status} ${response.statusText}`);
  process.exit(1);
}

console.log(`Added to ${body.draft.name} > ${body.entry.sectionTitle}: ${body.entry.bulletText}`);
