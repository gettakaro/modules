function parseConfig() {
  return {
    mcHost: process.env.MC_HOST || 'paper',
    mcPort: parseInt(process.env.MC_PORT || '25565', 10),
    mcVersion: process.env.MC_VERSION || '1.21.11',
    username: process.env.BOT_USERNAME || 'Bot',
    reconnectDelay: parseInt(process.env.BOT_RECONNECT_DELAY || '5000', 10),
    maxReconnectDelay: parseInt(process.env.BOT_MAX_RECONNECT_DELAY || '60000', 10),
    apiPort: parseInt(process.env.BOT_API_PORT || '3001', 10),
  };
}

module.exports = { parseConfig };
