#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer({
  googleKey: process.env.GOOGLE_MAPS_API_KEY || undefined,
  tomtomKey: process.env.TOMTOM_API_KEY || undefined,
});

await server.connect(new StdioServerTransport());
if (!process.env.GOOGLE_MAPS_API_KEY && !process.env.TOMTOM_API_KEY) {
  console.error("[yerevan-traffic] warning: neither GOOGLE_MAPS_API_KEY nor TOMTOM_API_KEY is set; routing tools will fail.");
}
