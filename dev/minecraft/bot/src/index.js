const { parseConfig } = require('./config');
const { createApi } = require('./api');

async function main() {
  const config = parseConfig();
  const bots = new Map();

  const server = await createApi(bots, config);

  const shutdown = () => {
    console.log('Shutting down...');
    for (const bot of bots.values()) {
      bot.destroy();
    }
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
