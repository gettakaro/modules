import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateNextHordeDay,
  extractCurrentDay,
  buildDaysUntilText,
  renderBloodMoonMessage,
} from '../src/functions/blood-moon-helpers.js';

describe('blood-moon-countdown helper behavior', () => {
  it('parses common 7D2D gettime outputs', () => {
    assert.equal(extractCurrentDay('Day 12, 14:30'), 12);
    assert.equal(extractCurrentDay('Game time: Day 27 06:00'), 27);
    assert.equal(extractCurrentDay('d: 7 h: 22 m: 00'), 7);
  });

  it('returns null when no current day is present', () => {
    assert.equal(extractCurrentDay('Server is running'), null);
  });

  it('calculates the next vanilla horde day including today', () => {
    assert.equal(calculateNextHordeDay(1, 7, 7), 7);
    assert.equal(calculateNextHordeDay(7, 7, 7), 7);
    assert.equal(calculateNextHordeDay(8, 7, 7), 14);
    assert.equal(calculateNextHordeDay(14, 7, 7), 14);
    assert.equal(calculateNextHordeDay(15, 7, 7), 21);
  });

  it('supports custom interval and first horde day', () => {
    assert.equal(calculateNextHordeDay(3, 5, 5), 5);
    assert.equal(calculateNextHordeDay(6, 5, 5), 10);
    assert.equal(calculateNextHordeDay(17, 5, 5), 20);
  });

  it('renders today and future day text through the response template', () => {
    assert.equal(buildDaysUntilText({ hordeTodayText: 'Horde night is tonight!' }, 0), 'Horde night is tonight!');
    assert.equal(buildDaysUntilText({ daysUntilText: '{daysUntil} days left' }, 3), '3 days left');

    const message = renderBloodMoonMessage('Current {currentDay}; next {nextHordeDay}; {daysUntilText}; source={source}', {
      currentDay: 11,
      nextHordeDay: 14,
      daysUntil: 3,
      daysUntilText: '3 days left',
      interval: 7,
      firstHordeDay: 7,
      source: 'console',
    });
    assert.equal(message, 'Current 11; next 14; 3 days left; source=console');
  });
});
