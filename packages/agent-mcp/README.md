# @ouispec/agent-mcp

A Model Context Protocol server for a product's agent tools.

```sh
npm install @ouispec/agent-mcp
```

- `createMCPApiToolServer` serves the tools `@ouispec/agent-worker` generates from the product's OpenAPI document. Each call runs as the MCP client's own principal, with that user's permissions, and an operation's declared effect decides whether it is offered as a read or a write.
- `handleMCPRequest` answers one MCP request over HTTP, for a product that hosts the server behind its own API.
- `createMCPToolServer` and `registerOUISurfaces` serve a product's own tools and its OUI surfaces.
- `createMCPServer` serves agent SDK intents.

The server names itself from what the product passes; nothing defaults to another product's name. It releases with the rest of the agent SDK, under one version: see [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md).
