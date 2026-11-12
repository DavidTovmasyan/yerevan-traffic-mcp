// Call a tool on the built MCP server over stdio, the way an MCP client does.
// Usage: node scripts/call.mjs <tool> '<json args>'
// Keys come from the environment (e.g. `node --env-file=.env scripts/call.mjs ...`) and are never printed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/call.mjs <tool> '<json args>'");
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], env });
const client = new Client({ name: "cli", version: "0" });
await client.connect(transport);
const res = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
for (const c of res.content) console.log(c.text);
if (res.isError) process.exitCode = 2;
await client.close();
