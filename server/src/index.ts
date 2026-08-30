import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import { rebuildRoutingIndex } from './gateway/ability-index.js';

async function main(): Promise<void> {
  migrate();
  rebuildRoutingIndex();

  const app = await buildApp();

  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`[server] AI Command Center listening on http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start');
    process.exit(1);
  }

  /**
   * Graceful shutdown. Streaming responses are the reason this matters: killing
   * the process mid-stream leaves a client waiting on a socket that will never
   * close, so give in-flight requests a moment before exiting.
   */
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[server] ${signal} received, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error('[server] error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
