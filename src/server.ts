import { getConfig } from "./lib/config.js";
import { buildApp } from "./app.js";

async function start() {
  const config = getConfig();
  const app = await buildApp(config);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
