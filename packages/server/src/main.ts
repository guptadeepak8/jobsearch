import { createServer } from './api/server.js';
import { BrowserManager } from './browser/browser-manager.js';
import { loadConfig } from './config/index.js';
import { AnswerMemory } from './memory/answer-memory.js';

async function main() {
  const config = loadConfig();

  const browserManager = new BrowserManager({
    userDataDir: config.RESOLVED_BROWSER_USER_DATA_DIR,
    headless: config.BROWSER_HEADLESS,
    slowMo: config.BROWSER_SLOW_MO,
    navigationTimeout: config.BROWSER_NAVIGATION_TIMEOUT,
    display: config.DISPLAY,
  });

  const answerMemory = new AnswerMemory(config.RESOLVED_DATABASE_PATH);

  const { app } = await createServer({
    browserManager,
    answerMemory,
    logger: true,
  });

  const shutdown = async () => {
    await browserManager.close();
    answerMemory.close();
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({
    port: config.PORT,
    host: config.HOST,
  });

  console.log(`Automation Server listening on http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
