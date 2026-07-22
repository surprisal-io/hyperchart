import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHyperchartMcpTools } from "./tools.js";

const require = createRequire(import.meta.url);

export async function main(): Promise<void> {
	const { version } = require("../../package.json") as { version: string };
	const server = new McpServer({ name: "hyperchart", version });
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	for (const definition of createHyperchartMcpTools({ cwd: process.cwd(), ...(sessionId === undefined ? {} : { sessionId }) })) {
		server.registerTool(
			definition.name,
			{ description: definition.description, inputSchema: definition.inputSchema },
			(args: Record<string, unknown>) => definition.handler(args ?? {}),
		);
	}
	await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("server.ts")) {
	void main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
