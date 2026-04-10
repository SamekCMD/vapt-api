import { buildApp } from "./app.js";

const host = "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

async function start() {
  const app = buildApp();

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
