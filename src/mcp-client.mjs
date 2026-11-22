import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const toolEnvironment = new Set([
  "MARKET_DATA_MODE", "TWELVE_DATA_API_KEY", "SEC_USER_AGENT",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"
]);

export function connectMcp() {
  const location = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => toolEnvironment.has(name.toUpperCase())));
  const child = spawn(process.execPath, [location], { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let id = 0;
  let closed = false;
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const shutDown = () => {
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(new Error("The stock research MCP server disconnected."));
    }
    pending.clear();
  };
  child.on("error", shutDown);
  child.on("exit", shutDown);
  child.stdin.on("error", shutDown);
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timeout);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  function request(method, params) {
    if (closed) return Promise.reject(new Error("The stock research MCP server is unavailable."));
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("The MCP tool request timed out."));
      }, 35_000);
      pending.set(requestId, { resolve, reject, timeout });
      send({ id: requestId, method, params });
    });
  }
  const ready = request("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stock-research-dashboard", version: "0.1.0" }
  }).then(async result => {
    if (result.protocolVersion !== "2025-11-25") throw new Error("Unsupported MCP version.");
    send({ method: "notifications/initialized" });
    return (await request("tools/list")).tools;
  });
  ready.catch(() => {});
  return {
    async list() { return ready; },
    async ping() {
      await ready;
      await request("ping");
    },
    async call(name, args) {
      const tools = await ready;
      if (!tools.some(tool => tool.name === name)) throw new Error("MCP tool is unavailable.");
      const result = await request("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return result.structuredContent;
    },
    close() {
      shutDown();
      lines.close();
      child.kill();
    }
  };
}
