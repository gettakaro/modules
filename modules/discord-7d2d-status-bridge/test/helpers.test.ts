import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import * as vm from 'node:vm';

interface HelperExports {
  parse7d2dTime: (raw: string) => { day: number; hour: number | null; minute: number | null; time: string } | null;
  nextHordeDay: (currentDay: number, firstHordeDay?: number, interval?: number) => number;
  isBloodMoonDay: (day: number, firstHordeDay?: number, interval?: number) => boolean;
  isBloodMoonActive: (parsed: { day: number; hour: number | null }, firstHordeDay?: number, interval?: number, startHour?: number, endHour?: number) => boolean;
  renderTemplate: (template: string, status: Record<string, unknown>, config: Record<string, unknown>) => string;
  sanitizeDiscordMessage: (message: string) => string;
  isGlobalChatMessage: (eventData: Record<string, unknown>) => boolean;
}

const helperPath = new URL('../src/functions/discord-7d2d-status-helpers.js', import.meta.url);
let source = readFileSync(helperPath, 'utf8');
source = source.replace("import { takaro } from '@takaro/helpers';", 'const takaro = {};');
source = source.replace(/export /g, '');
source += '\nmodule.exports = { parse7d2dTime, nextHordeDay, isBloodMoonDay, isBloodMoonActive, renderTemplate, sanitizeDiscordMessage, isGlobalChatMessage };';
const sandbox: { module: { exports: HelperExports | Record<string, never> }; console: Console } = { module: { exports: {} }, console };
vm.runInNewContext(source, sandbox, { filename: helperPath.pathname });
const { parse7d2dTime, nextHordeDay, isBloodMoonDay, isBloodMoonActive, renderTemplate, sanitizeDiscordMessage, isGlobalChatMessage } = sandbox.module.exports as HelperExports;

describe('discord-7d2d-status-helpers', () => {
  it('parses active 7D2D gettime output', () => {
    assert.equal(JSON.stringify(parse7d2dTime('Day 4, 16:52')), JSON.stringify({ day: 4, hour: 16, minute: 52, time: '16:52' }));
    assert.equal(JSON.stringify(parse7d2dTime('Day: 7, 22:01')), JSON.stringify({ day: 7, hour: 22, minute: 1, time: '22:01' }));
  });

  it('calculates horde day and active blood moon window', () => {
    assert.equal(nextHordeDay(4, 7, 7), 7);
    assert.equal(nextHordeDay(8, 7, 7), 14);
    assert.equal(isBloodMoonDay(14, 7, 7), true);
    const start = parse7d2dTime('Day 7, 22:00');
    const lateNight = parse7d2dTime('Day 8, 03:30');
    const over = parse7d2dTime('Day 8, 04:00');
    if (!start || !lateNight || !over) throw new Error('test setup failed to parse 7D2D time');
    assert.equal(isBloodMoonActive(start, 7, 7, 22, 4), true);
    assert.equal(isBloodMoonActive(lateNight, 7, 7, 22, 4), true);
    assert.equal(isBloodMoonActive(over, 7, 7, 22, 4), false);
  });

  it('renders Polish status template', () => {
    const status = { onlinePlayers: 5, day: 60, time: '14:43', bloodMoonActive: true, serverName: '7D2D' };
    assert.equal(renderTemplate('{onlinePlayers} os. ⭔ Dzień {day} ⭔ {time}{bloodMoonIcon}', status, { bloodMoonIcon: ' ⭔ 🩸' }), '5 os. ⭔ Dzień 60 ⭔ 14:43 ⭔ 🩸');
  });

  it('sanitizes Discord mention spam', () => {
    assert.equal(sanitizeDiscordMessage('@everyone @here <@123> <@!234> <@&456>'), '@\u200beveryone @\u200bhere <@\u200b123> <@\u200b234> <@&\u200b456>');
  });

  it('only relays explicit global/public game chat', () => {
    assert.equal(isGlobalChatMessage({ channel: 'global' }), true);
    assert.equal(isGlobalChatMessage({ chatType: 'public' }), true);
    assert.equal(isGlobalChatMessage({ scope: 'all' }), true);
    assert.equal(isGlobalChatMessage({ channel: 'team' }), false);
    assert.equal(isGlobalChatMessage({ type: 'whisper', recipient: 'player2' }), false);
    assert.equal(isGlobalChatMessage({ msg: 'missing scope defaults private' }), false);
  });
});
