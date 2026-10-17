const assert = require('assert');
const express = require('express');
const http = require('http');
const { BotInstance } = require('../src/bot-instance');
const { parseConfig } = require('../src/config');

// Helper to make HTTP requests
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testConfigVersion() {
  const config = parseConfig();
  assert.strictEqual(config.mcVersion, '1.21.11', 'Default mcVersion should be 1.21.11');
  console.log('PASS: config default mcVersion is 1.21.11');
}

async function testBotInstanceAcceptsVersion() {
  const bot = new BotInstance({
    name: 'test',
    host: 'localhost',
    port: 25565,
    username: 'Test',
    version: '1.21.11',
    reconnectDelay: 5000,
    maxReconnectDelay: 60000,
  });
  assert.strictEqual(bot.version, '1.21.11', 'BotInstance should store version');
  console.log('PASS: BotInstance stores version from constructor');
}

async function testApiValidation() {
  const { createApi } = require('../src/api');
  const bots = new Map();

  const mockBot = {
    connected: true,
    name: 'testbot',
    getStatus() { return { connected: true, name: 'testbot' }; },
    chat(msg) { return { sent: msg }; },
    moveTo(x, y, z) { return { movingTo: { x, y, z } }; },
    lookAt(x, y, z) { return { lookingAt: { x, y, z } }; },
  };
  bots.set('testbot', mockBot);

  const config = { ...parseConfig(), apiPort: 0 };
  const server = await createApi(bots, config);
  const port = server.address().port;

  try {
    // Test chat validation - missing message
    let res = await request(port, 'POST', '/bot/testbot/chat', {});
    assert.strictEqual(res.status, 400, 'Should reject empty chat message');
    console.log('PASS: chat rejects missing message');

    // Test chat validation - non-string message
    res = await request(port, 'POST', '/bot/testbot/chat', { message: 123 });
    assert.strictEqual(res.status, 400, 'Should reject non-string chat message');
    console.log('PASS: chat rejects non-string message');

    // Test chat validation - empty string
    res = await request(port, 'POST', '/bot/testbot/chat', { message: '' });
    assert.strictEqual(res.status, 400, 'Should reject empty string chat message');
    console.log('PASS: chat rejects empty string message');

    // Test chat validation - valid message
    res = await request(port, 'POST', '/bot/testbot/chat', { message: 'hello' });
    assert.strictEqual(res.status, 200, 'Should accept valid chat message');
    assert.deepStrictEqual(res.body, { sent: 'hello' });
    console.log('PASS: chat accepts valid message');

    // Test move validation - missing coords
    res = await request(port, 'POST', '/bot/testbot/move', {});
    assert.strictEqual(res.status, 400, 'Should reject missing move coords');
    console.log('PASS: move rejects missing coordinates');

    // Test move validation - non-number coords
    res = await request(port, 'POST', '/bot/testbot/move', { x: 'a', y: 1, z: 2 });
    assert.strictEqual(res.status, 400, 'Should reject non-number move coords');
    console.log('PASS: move rejects non-number coordinates');

    // Test look validation - missing coords
    res = await request(port, 'POST', '/bot/testbot/look', {});
    assert.strictEqual(res.status, 400, 'Should reject missing look coords');
    console.log('PASS: look rejects missing coordinates');

    // Test look validation - valid coords
    res = await request(port, 'POST', '/bot/testbot/look', { x: 1, y: 2, z: 3 });
    assert.strictEqual(res.status, 200, 'Should accept valid look coords');
    console.log('PASS: look accepts valid coordinates');

    // Test 404 for unknown bot
    res = await request(port, 'POST', '/bot/unknown/chat', { message: 'hi' });
    assert.strictEqual(res.status, 404, 'Should 404 for unknown bot');
    console.log('PASS: returns 404 for unknown bot');

    // Test username length validation - name that exceeds 16-char limit
    // Config username default is 'Bot' (or whatever env says), prefix + '_' + name must be <= 16
    // With default 'Bot' (3 chars) + '_' (1 char) = 4 char prefix, max name = 12 chars
    // Use a name that will definitely exceed 16 chars with any prefix
    res = await request(port, 'POST', '/bots', { name: 'thisIsAVeryLongBotName' });
    assert.strictEqual(res.status, 400, 'Should reject bot name that exceeds 16-char username limit');
    assert.ok(res.body.error.includes('16-character limit'), 'Error should mention 16-character limit');
    console.log('PASS: rejects bot name that exceeds 16-char username limit');

    // Test username length validation - name that fits within limit
    // With default config username 'Bot' + '_' = 4 chars, so 5-char name = 9 total (ok)
    res = await request(port, 'POST', '/bots', { name: 'short' });
    // This will try to actually connect (and fail since no MC server), but should return 201
    assert.strictEqual(res.status, 201, 'Should accept bot name within 16-char username limit');
    console.log('PASS: accepts bot name within 16-char username limit');
    // Clean up: mark as destroyed and remove from map
    // The bot may still be in the process of connecting, so we can't call quit()
    const shortBot = bots.get('short');
    if (shortBot) {
      shortBot.destroyed = true;
      if (shortBot.reconnectTimer) clearTimeout(shortBot.reconnectTimer);
      if (shortBot.bot && typeof shortBot.bot.quit === 'function') {
        shortBot.bot.removeAllListeners();
        shortBot.bot.quit();
      }
    }
    bots.delete('short');

    // Test create bot - missing name
    res = await request(port, 'POST', '/bots', {});
    assert.strictEqual(res.status, 400, 'Should reject missing bot name');
    console.log('PASS: rejects missing bot name');

    console.log('\nAll tests passed!');
  } finally {
    server.close();
  }
}

async function main() {
  await testConfigVersion();
  await testBotInstanceAcceptsVersion();
  await testApiValidation();
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
