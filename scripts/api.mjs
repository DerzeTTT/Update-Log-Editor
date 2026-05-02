import { spawn } from "node:child_process";
import net from "node:net";

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

if (await isPortOpen(4317)) {
  console.log("Update Log Editor API is already running on http://127.0.0.1:4317");
  process.exit(0);
}

const child = spawn("npx", ["tsx", "server/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, FORCE_COLOR: "1" },
  shell: process.platform === "win32",
  stdio: "inherit"
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
