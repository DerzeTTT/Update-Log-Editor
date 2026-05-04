import { spawn } from "node:child_process";
import net from "node:net";
import open from "open";

const processes = [];
const env = { ...process.env, FORCE_COLOR: "1" };
const args = new Set(process.argv.slice(2));
const noOpen = args.has("--no-open") || args.has("--headless") || process.env.UPDATE_LOG_NO_OPEN === "1";
const frontendUrl = "http://127.0.0.1:5173";
const apiUrl = "http://127.0.0.1:4317";
let shuttingDown = false;
let exitingAfterFailure = false;

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(600, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function run(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  processes.push(child);
  child.on("exit", (code) => {
    if (shuttingDown || exitingAfterFailure) {
      return;
    }
    const exitCode = typeof code === "number" && code !== 0 ? code : 1;
    console.error(`${name} exited unexpectedly${code === null ? "" : ` with code ${code}`}.`);
    exitingAfterFailure = true;
    shutdown();
    process.exit(exitCode);
  });
  return child;
}

async function openFrontend() {
  if (noOpen) {
    return true;
  }

  try {
    await open(frontendUrl);
    return true;
  } catch (error) {
    console.error("Could not open browser:", error.message);
    return false;
  }
}

const apiRunning = await isPortOpen(4317);
const clientRunning = await isPortOpen(5173);

if (apiRunning && clientRunning) {
  console.log("Update Log Editor is already running.");
  console.log(`Frontend: ${frontendUrl}`);
  console.log(`API: ${apiUrl}`);
  process.exit((await openFrontend()) ? 0 : 1);
}

if (apiRunning || clientRunning) {
  console.log("Update Log Editor appears to be partially running; not starting duplicate processes.");
  if (apiRunning) console.log(`API is already running on ${apiUrl}`);
  if (clientRunning) console.log(`Frontend is already running on ${frontendUrl}`);
  console.log("Stop the existing process first if you want to restart it.");
  process.exit(1);
}

run("server", "npx", ["tsx", "server/index.ts"]);
run("client", "npx", ["vite", "--host", "127.0.0.1"]);

if (!noOpen) {
  setTimeout(() => {
    openFrontend();
  }, 1400);
} else {
  console.log(`Browser auto-open disabled. Frontend: ${frontendUrl} API: ${apiUrl}`);
}

function shutdown() {
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) {
      child.kill();
    }
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
