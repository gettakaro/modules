import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getPlayerGameId,
  getRoleNames,
  renderTemplate,
  selectPermissionForRoles,
} from '../src/functions/permission-sync-helpers.js';

describe('discord-role-permission-sync helpers', () => {
  it('matches Takaro role names case-insensitively and chooses the first configured mapping', () => {
    const selection = selectPermissionForRoles(['Member', 'Diamond'], {
      rolePermissionMappings: [
        { roleName: 'diamond', permissionLevel: 200 },
        { roleName: 'Member', permissionLevel: 900 },
      ],
    });

    assert.deepEqual(selection, {
      matched: true,
      matchedRole: 'diamond',
      permissionLevel: 200,
    });
  });

  it('can apply an optional fallback permission level to unmatched players', () => {
    const selection = selectPermissionForRoles(['Member'], {
      rolePermissionMappings: [{ roleName: 'VIP', permissionLevel: 250 }],
      unmatchedPermissionLevel: 1000,
    });

    assert.deepEqual(selection, {
      matched: false,
      matchedRole: '',
      permissionLevel: 1000,
    });
  });

  it('leaves unmatched players unchanged when no fallback is configured', () => {
    const selection = selectPermissionForRoles(['Member'], {
      rolePermissionMappings: [{ roleName: 'VIP', permissionLevel: 250 }],
      unmatchedPermissionLevel: null,
    });

    assert.equal(selection.permissionLevel, null);
    assert.equal(selection.matched, false);
  });

  it('extracts role names from common POG role shapes', () => {
    assert.deepEqual(
      getRoleNames({
        roles: [
          { name: 'Diamond' },
          { friendlyName: 'Supporter' },
          { role: { name: 'Nested' } },
          { roleName: 'Legacy' },
        ],
      }),
      ['Diamond', 'Supporter', 'Nested', 'Legacy'],
    );
  });

  it('renders a safe 7D2D admin command with quoted names when necessary', () => {
    const command = renderTemplate('admin add {playerGameId} {permissionLevel}', {
      playerGameId: 'Player With Spaces',
      playerName: 'Player With Spaces',
      permissionLevel: 200,
      matchedRole: 'Diamond',
    });

    assert.equal(command, 'admin add "Player With Spaces" 200');
  });

  it('prefers the POG gameId as the console-command player identifier', () => {
    assert.equal(
      getPlayerGameId({ id: 'player-id', gameId: 'event-game-id', name: 'Name' }, { gameId: 'pog-game-id' }),
      'pog-game-id',
    );
  });
});
