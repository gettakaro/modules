import { data, takaro } from '@takaro/helpers';

const DEFAULT_WARNINGS = {
  warning60: {
    minutesRemaining: 60,
    message: 'Server reboot in 60 minutes. Please plan accordingly.',
  },
  warning30: {
    minutesRemaining: 30,
    message: 'Server reboot in 30 minutes.',
  },
  warning15: {
    minutesRemaining: 15,
    message: 'Server reboot in 15 minutes. Please get somewhere safe.',
  },
  warning5: {
    minutesRemaining: 5,
    message: 'Server reboot in 5 minutes. Log out soon to avoid losing progress.',
  },
  warning1: {
    minutesRemaining: 1,
    message: 'Server reboot in 1 minute. Log out now.',
  },
};

const KNOWN_PLACEHOLDERS = new Set(['minutesRemaining', 'serverName', 'playerCount']);

function getWarningConfig(config, warningKey) {
  const defaults = DEFAULT_WARNINGS[warningKey];
  const userWarning = config?.[warningKey] ?? {};
  return {
    enabled: userWarning.enabled ?? true,
    message: userWarning.message ?? defaults.message,
    minutesRemaining: defaults.minutesRemaining,
  };
}

async function getOnlinePlayerCount(gameServerId) {
  const onlineRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
    filters: {
      gameServerId: [gameServerId],
      online: [true],
    },
    limit: 1,
  });
  return onlineRes.data.meta.total;
}

async function getServerName(gameServerId) {
  try {
    const serverRes = await takaro.gameserver.gameServerControllerGetOne(gameServerId);
    return serverRes.data.data?.name ?? '';
  } catch (err) {
    console.error(`reboot-warnings: failed to fetch server name, leaving {serverName} unchanged. Error: ${err}`);
    return '';
  }
}

function warnUnknownPlaceholders(text) {
  const remaining = text.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
  if (!remaining || remaining.length === 0) return;

  const unknown = [...new Set(remaining.map((token) => token.slice(1, -1)).filter((name) => !KNOWN_PLACEHOLDERS.has(name)))];
  if (unknown.length > 0) {
    console.warn(`reboot-warnings: unrecognised placeholders in message text: ${unknown.map((name) => `{${name}}`).join(', ')}`);
  }
}

async function renderMessage(rawMessage, { minutesRemaining, playerCount, gameServerId }) {
  let message = String(rawMessage ?? '');
  message = message.replace(/\{minutesRemaining\}/g, String(minutesRemaining));
  message = message.replace(/\{playerCount\}/g, String(playerCount));

  if (message.includes('{serverName}')) {
    const serverName = await getServerName(gameServerId);
    if (serverName) {
      message = message.replace(/\{serverName\}/g, serverName);
    }
  }

  warnUnknownPlaceholders(message);
  return message;
}

export async function sendRebootWarning(warningKey) {
  const { gameServerId, module: mod } = data;
  const config = mod.userConfig ?? {};
  const warning = getWarningConfig(config, warningKey);

  if (!warning.enabled) {
    console.log(`reboot-warnings: ${warningKey} disabled, skipping`);
    return;
  }

  if (!warning.message || !warning.message.trim()) {
    console.log(`reboot-warnings: ${warningKey} message is blank, skipping`);
    return;
  }

  const playerCount = await getOnlinePlayerCount(gameServerId);
  if ((config.skipWhenNoPlayersOnline ?? true) && playerCount === 0) {
    console.log(`reboot-warnings: no players online, skipping ${warningKey}`);
    return;
  }

  const message = await renderMessage(warning.message, {
    minutesRemaining: warning.minutesRemaining,
    playerCount,
    gameServerId,
  });

  console.log(`reboot-warnings: sending ${warningKey} (${warning.minutesRemaining} minutes remaining): ${message}`);
  await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
    message,
    opts: {},
  });
  console.log(`reboot-warnings: ${warningKey} broadcast complete`);
}
