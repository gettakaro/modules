const express = require('express');
const { BotInstance } = require('./bot-instance');

function createApi(bots, config) {
  const app = express();
  app.use(express.json());

  function getBot(req, res) {
    const bot = bots.get(req.params.name);
    if (!bot) {
      res.status(404).json({ error: `Unknown bot: ${req.params.name}` });
      return null;
    }
    if (!bot.connected) {
      res.status(503).json({ error: `Bot ${req.params.name} not connected` });
      return null;
    }
    return bot;
  }

  // Bot management endpoints

  app.post('/bots', (req, res) => {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (bots.has(name)) {
      return res.status(409).json({ error: `Bot ${name} already exists` });
    }

    // Minecraft usernames have a 16-character limit.
    // The full username is `${prefix}_${name}`, so validate the combined length.
    const fullUsername = `${config.username}_${name}`;
    if (fullUsername.length > 16) {
      return res.status(400).json({
        error: `Username "${fullUsername}" exceeds Minecraft's 16-character limit (${fullUsername.length} chars). Use a shorter bot name.`,
      });
    }

    const bot = new BotInstance({
      name,
      host: config.mcHost,
      port: config.mcPort,
      username: config.username,
      version: config.mcVersion,
      reconnectDelay: config.reconnectDelay,
      maxReconnectDelay: config.maxReconnectDelay,
    });
    bots.set(name, bot);
    bot.connect();

    res.status(201).json({ created: name, username: bot.username });
  });

  app.delete('/bots/:name', (req, res) => {
    const bot = bots.get(req.params.name);
    if (!bot) {
      return res.status(404).json({ error: `Unknown bot: ${req.params.name}` });
    }
    bot.destroy();
    bots.delete(req.params.name);
    res.json({ deleted: req.params.name });
  });

  app.get('/status', (_req, res) => {
    const status = {};
    for (const [name, bot] of bots) {
      status[name] = bot.getStatus();
    }
    res.json(status);
  });

  // Per-bot action endpoints

  app.post('/bot/:name/chat', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    const { message } = req.body;
    if (typeof message !== 'string' || message.length === 0) {
      return res.status(400).json({ error: 'message must be a non-empty string' });
    }
    res.json(bot.chat(message));
  });

  app.post('/bot/:name/move', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    const { x, y, z } = req.body;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return res.status(400).json({ error: 'x, y, z must be finite numbers' });
    }
    res.json(bot.moveTo(x, y, z));
  });

  app.post('/bot/:name/attack', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.attack());
  });

  app.post('/bot/:name/use', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.useBlock());
  });

  app.post('/bot/:name/look', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    const { x, y, z } = req.body;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return res.status(400).json({ error: 'x, y, z must be finite numbers' });
    }
    res.json(bot.lookAt(x, y, z));
  });

  app.post('/bot/:name/jump', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.jump());
  });

  app.post('/bot/:name/respawn', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.respawn());
  });

  app.get('/bot/:name/players', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.getPlayers());
  });

  app.get('/bot/:name/position', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.getPosition());
  });

  app.get('/bot/:name/health', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.getHealth());
  });

  app.get('/bot/:name/inventory', (req, res) => {
    const bot = getBot(req, res);
    if (!bot) return;
    res.json(bot.getInventory());
  });

  // Global error handler to prevent unhandled exceptions from crashing the process
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  });

  return new Promise((resolve) => {
    const server = app.listen(config.apiPort, () => {
      console.log(`Bot API listening on port ${config.apiPort}`);
      resolve(server);
    });
  });
}

module.exports = { createApi };
