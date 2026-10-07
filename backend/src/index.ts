import "dotenv/config";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createConfiguredPaymentProvider } from "./payments/configured-provider.js";
import { PostgresStore } from "./repositories/postgres-store.js";
import { createConfiguredWechatAuthProvider } from "./wechat/mini-program-auth.js";

const config = loadConfig(process.env, "api");
const store = new PostgresStore(createPool(config));
const wechatAuthProvider = createConfiguredWechatAuthProvider(config);
const paymentProvider = await createConfiguredPaymentProvider(config);
const app = await buildApp({
  config,
  store,
  ...(wechatAuthProvider ? { wechatAuthProvider } : {}),
  ...(paymentProvider ? { paymentProvider } : {}),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
