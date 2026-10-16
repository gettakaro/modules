import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const purePath = path.resolve(__dirname, '../src/functions/discord-server-status-pure.js');
const {
  buildStatusMessage,
  formatPlayerList,
  normalizeTriggers,
} = await import(purePath);

describe('discord-server-status: pure helper tests', () => {
  it('renders default status with sorted online player names', () => {
    const message = buildStatusMessage({
      serverName: 'Survival',
      onlinePlayers: [{ name: 'Zed' }, { name: 'alice' }],
      config: {},
      generatedAt: '2026-07-17T00:00:00Z',
    });

    assert.equal(message, 'Survival: 2 players online. Players: alice, Zed');
  });

  it('renders an empty-server message', () => {
    const message = buildStatusMessage({
      serverName: 'Build',
      onlinePlayers: [],
      config: {},
      generatedAt: '2026-07-17T00:00:00Z',
    });

    assert.equal(message, 'Build: 0 players online. Nobody is online right now.');
  });

  it('can hide player names for count-only Discord status', () => {
    const message = buildStatusMessage({
      serverName: 'PvP',
      onlinePlayers: [{ name: 'A' }, { name: 'B' }],
      config: {
        includePlayerNames: false,
        statusTemplate: '{serverName}: {onlineCount} {playerNoun} online.',
      },
    });

    assert.equal(message, 'PvP: 2 players online.');
  });

  it('limits visible player names and reports the hidden count', () => {
    const list = formatPlayerList(
      [{ name: 'Delta' }, { name: 'Bravo' }, { name: 'Charlie' }, { name: 'Alpha' }],
      { includePlayerNames: true, maxPlayerNames: 2 },
    );

    assert.equal(list, 'Alpha, Bravo, +2 more');
  });

  it('normalizes Discord triggers', () => {
    assert.deepEqual(normalizeTriggers([' !Status ', '!status', '', null, '!Players']), ['!status', '!players']);
  });
});
