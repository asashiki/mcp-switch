import { createMcpGatewayApp } from "./app.js";

const { env, server } = await createMcpGatewayApp();

const address = await server.listen({
  host: env.HOST,
  port: env.PORT
});

server.log.info(`MCP Gateway listening on ${address}`);
