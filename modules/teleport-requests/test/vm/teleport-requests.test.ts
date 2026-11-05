import { expect } from '../../../../test/support/expect.ts';
import { describe } from 'node:test';
import { createModuleTest, type ModuleTest } from '@takaro/module-test';

const MODULE = new URL('../../', import.meta.url);
const group = 'Teleport requests suite (module-VM)';

// The VM gets its own Date, so every case pins the clock.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString();

const ME = { name: 'Alice', position: { x: 10, y: 20, z: 30, dimension: 'overworld' } };
const BOB = { name: 'Bob', position: { x: 100, y: 64, z: -50, dimension: 'overworld' } };
const CAROL = { name: 'Carol', position: { x: -5, y: 70, z: 5 } };
const USE = [{ permission: 'TPA_USE' }];

type Row = { key: string; value: string; playerId?: string | null; expiresAt?: string };

/** Seeds a request from `otherPlayers[index]` to the acting player. */
function seedIncoming(t: ModuleTest, index: number, mode: 'to' | 'here', opts: { createdAt?: number; expiresIn?: number } = {}) {
  const from = t.otherPlayers[index]!;
  const expiresAt = at(opts.expiresIn ?? 60);
  t.variables.insert({
    key: `tpa_req_${t.pog.playerId}`,
    value: JSON.stringify({
      mode,
      requesterId: from.pog.playerId,
      requesterName: from.player.name,
      targetId: t.pog.playerId,
      targetName: t.player.name,
      bypassCooldown: false,
      createdAt: at(opts.createdAt ?? -10),
      expiresAt,
    }),
    expiresAt,
    playerId: from.pog.playerId,
    gameServerId: t.gameServerId,
    moduleId: t.moduleId,
  });
}

const requestRows = (t: ModuleTest) => (t.variables.all as Row[]).filter((r) => r.key.startsWith('tpa_req_'));

const tests = [
  createModuleTest({
    name: '/tpa stores a request and messages both players',
    module: MODULE,
    now: NOW,
    permissions: USE,
    player: ME,
    otherPlayers: [BOB],
    test: async function () {
      const bob = this.otherPlayers[0]!;
      const res = await this.runCommand('tpa', { player: bob.pog });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;

      const rows = requestRows(this);
      expect(rows).to.have.length(1);
      expect(rows[0]!.key).to.equal(`tpa_req_${bob.pog.playerId}`);
      expect(rows[0]!.playerId).to.equal(this.pog.playerId);
      expect(rows[0]!.expiresAt).to.equal(at(60));
      expect(JSON.parse(rows[0]!.value)).to.include({ mode: 'to', requesterName: 'Alice', targetName: 'Bob' });

      expect(this.client.pmsTo(bob.pog.gameId)).to.deep.equal([
        'Alice wants to teleport to you. Type /tpaccept or /tpdeny (expires in 60s).',
      ]);
      expect(this.pms()).to.deep.equal(['Request sent to Bob. It expires in 60s.']);
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: '/tpahere words the request the other way round and uses the configured timeout',
    module: MODULE,
    now: NOW,
    permissions: USE,
    player: ME,
    otherPlayers: [BOB],
    userConfig: { requestTimeout: 90_000, cost: 5 },
    currency: 10,
    test: async function () {
      const bob = this.otherPlayers[0]!;
      const res = await this.runCommand('tpahere', { player: bob.pog });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(this.client.pmsTo(bob.pog.gameId)).to.deep.equal([
        'Alice wants you to teleport to them. Type /tpaccept or /tpdeny (expires in 1m 30s).',
      ]);
      expect(this.pms()).to.deep.equal(['Request sent to Bob. It expires in 1m 30s. It costs you 5 if accepted.']);
      expect(JSON.parse(requestRows(this)[0]!.value).mode).to.equal('here');
    },
  }),

  createModuleTest({
    name: '/tpa needs TPA_USE',
    module: MODULE,
    now: NOW,
    permissions: [],
    otherPlayers: [BOB],
    test: async function () {
      const res = await this.runCommand('tpa', { player: this.otherPlayers[0]!.pog });
      expect(res.success).to.be.false;
      expect(this.userError(res)).to.equal('You do not have permission to send teleport requests.');
      expect(requestRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: '/tpa refuses yourself and offline players',
    module: MODULE,
    now: NOW,
    permissions: USE,
    otherPlayers: [{ ...BOB, online: false }],
    test: async function () {
      const self = await this.runCommand('tpa', { player: this.pog });
      expect(this.userError(self)).to.equal('You cannot send a teleport request to yourself.');

      const offline = await this.runCommand('tpa', { player: this.otherPlayers[0]!.pog });
      expect(this.userError(offline)).to.equal('Bob is not online.');
      expect(requestRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'only one open request per player; it can be cancelled, and the target is told',
    module: MODULE,
    now: NOW,
    permissions: USE,
    player: ME,
    otherPlayers: [BOB, CAROL],
    test: async function () {
      const [bob, carol] = this.otherPlayers;
      expect((await this.runCommand('tpa', { player: bob!.pog })).success).to.be.true;

      const second = await this.runCommand('tpa', { player: carol!.pog });
      expect(this.userError(second)).to.equal(
        'You already have a request open to Bob. Wait for it, or type /tpcancel first.',
      );

      const cancel = await this.runCommand('tpcancel');
      expect(cancel.success, JSON.stringify(cancel.logs)).to.be.true;
      expect(requestRows(this)).to.have.length(0);
      expect(this.client.pmsTo(bob!.pog.gameId)).to.include('Alice cancelled their teleport request.');

      expect((await this.runCommand('tpa', { player: carol!.pog })).success).to.be.true;
      expect(this.pms().at(-1)).to.equal('Request sent to Carol. It expires in 60s.');
    },
  }),

  createModuleTest({
    name: 'an expired request does not block a new one',
    module: MODULE,
    now: NOW,
    permissions: USE,
    otherPlayers: [BOB, CAROL],
    setup: function () {
      const expiresAt = at(-1);
      this.variables.insert({
        key: `tpa_req_${this.otherPlayers[0]!.pog.playerId}`,
        value: JSON.stringify({ targetName: 'Bob', expiresAt }),
        expiresAt,
        playerId: this.pog.playerId,
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const res = await this.runCommand('tpa', { player: this.otherPlayers[1]!.pog });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
    },
  }),

  createModuleTest({
    name: '/tpcancel without a request explains it',
    module: MODULE,
    now: NOW,
    test: async function () {
      const res = await this.runCommand('tpcancel');
      expect(this.userError(res)).to.equal('You have no open teleport request.');
    },
  }),

  createModuleTest({
    name: 'the cooldown blocks a new request, TPA_BYPASS_COOLDOWN skips it',
    module: MODULE,
    now: NOW,
    permissions: USE,
    otherPlayers: [BOB],
    setup: function () {
      this.variables.insert({
        key: 'tpa_cooldown',
        value: JSON.stringify({ usedAt: at(-30) }),
        expiresAt: at(30),
        playerId: this.pog.playerId,
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const res = await this.runCommand('tpa', { player: this.otherPlayers[0]!.pog });
      expect(this.userError(res)).to.equal('You can send a teleport request again in 30s.');
    },
  }),

  createModuleTest({
    name: 'TPA_BYPASS_COOLDOWN ignores the cooldown and is remembered on the request',
    module: MODULE,
    now: NOW,
    permissions: [{ permission: 'TPA_USE' }, { permission: 'TPA_BYPASS_COOLDOWN' }],
    otherPlayers: [BOB],
    setup: function () {
      this.variables.insert({
        key: 'tpa_cooldown',
        value: '{}',
        expiresAt: at(30),
        playerId: this.pog.playerId,
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const res = await this.runCommand('tpa', { player: this.otherPlayers[0]!.pog });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(JSON.parse(requestRows(this)[0]!.value).bypassCooldown).to.equal(true);
    },
  }),

  createModuleTest({
    name: 'a request is refused up front when the player cannot pay',
    module: MODULE,
    now: NOW,
    permissions: USE,
    currency: 3,
    userConfig: { cost: 5 },
    otherPlayers: [BOB],
    test: async function () {
      const res = await this.runCommand('tpa', { player: this.otherPlayers[0]!.pog });
      expect(this.userError(res)).to.equal('A teleport costs 5 and you have 3.');
      expect(requestRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: '/tpaccept moves the requester to the target, then charges and starts the cooldown',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [{ ...BOB, currency: 50 }],
    userConfig: { cost: 20, cooldown: 120_000 },
    setup: function () {
      seedIncoming(this, 0, 'to');
    },
    test: async function () {
      const bob = this.otherPlayers[0]!;
      const res = await this.runCommand('tpaccept');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;

      const teleport = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(teleport).to.have.been.calledOnce;
      expect(teleport?.firstCall.args[1]).to.equal(bob.pog.playerId);
      expect(teleport?.firstCall.args[2]).to.deep.equal({ x: 10, y: 20, z: 30, dimension: 'overworld' });

      expect(this.currency.balanceOf(bob.pog.playerId)).to.equal(30);
      const cooldown = (this.variables.all as Row[]).find((r) => r.key === 'tpa_cooldown');
      expect(cooldown?.playerId).to.equal(bob.pog.playerId);
      expect(cooldown?.expiresAt).to.equal(at(120));
      expect(requestRows(this)).to.have.length(0);

      expect(this.pms()).to.deep.equal(['Accepted. Bob was teleported to you.']);
      expect(this.client.pmsTo(bob.pog.gameId)).to.deep.equal(['Alice accepted. Teleported to Alice (-20).']);
    },
  }),

  createModuleTest({
    name: '/tpaccept on a tpahere request moves the target, with the height offset',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [BOB],
    userConfig: { teleportYOffset: 2, cooldown: 0 },
    setup: function () {
      seedIncoming(this, 0, 'here');
    },
    test: async function () {
      const res = await this.runCommand('tpaccept');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;

      const teleport = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(teleport?.firstCall.args[1]).to.equal(this.pog.playerId);
      expect(teleport?.firstCall.args[2]).to.deep.equal({ x: 100, y: 66, z: -50, dimension: 'overworld' });
      expect(this.pms()).to.deep.equal(['Teleported to Bob.']);
      expect(this.client.pmsTo(this.otherPlayers[0]!.pog.gameId)).to.deep.equal([
        'Alice accepted and was teleported to you.',
      ]);
      expect((this.variables.all as Row[]).some((r) => r.key === 'tpa_cooldown')).to.equal(false);
    },
  }),

  createModuleTest({
    name: '/tpaccept picks a request by name and lists the rest',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [BOB, CAROL],
    setup: function () {
      seedIncoming(this, 0, 'to', { createdAt: -20 });
      seedIncoming(this, 1, 'to', { createdAt: -10 });
    },
    test: async function () {
      const res = await this.runCommand('tpaccept', { player: 'car' });
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const teleport = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(teleport?.firstCall.args[1]).to.equal(this.otherPlayers[1]!.pog.playerId);
      expect(this.pms()).to.deep.equal([
        'Accepted. Carol was teleported to you.',
        'You have 1 more request(s). Type /tpaccept <name> or /tpdeny <name>.',
      ]);
      expect(requestRows(this).map((r) => r.playerId)).to.deep.equal([this.otherPlayers[0]!.pog.playerId]);

      const unknown = await this.runCommand('tpaccept', { player: 'zed' });
      expect(this.userError(unknown)).to.equal('You have no teleport request from "zed".');
    },
  }),

  createModuleTest({
    name: '/tpaccept without a name takes the oldest request',
    module: MODULE,
    now: NOW,
    otherPlayers: [BOB, CAROL],
    setup: function () {
      seedIncoming(this, 0, 'to', { createdAt: -5 });
      seedIncoming(this, 1, 'to', { createdAt: -50 });
    },
    test: async function () {
      const res = await this.runCommand('tpaccept');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      const teleport = this.client.stubs.gameserver.gameServerControllerTeleportPlayer;
      expect(teleport?.firstCall.args[1]).to.equal(this.otherPlayers[1]!.pog.playerId);
    },
  }),

  createModuleTest({
    name: '/tpaccept ignores expired requests',
    module: MODULE,
    now: NOW,
    otherPlayers: [BOB],
    setup: function () {
      seedIncoming(this, 0, 'to', { expiresIn: -1 });
    },
    test: async function () {
      const res = await this.runCommand('tpaccept');
      expect(this.userError(res)).to.equal('You have no pending teleport requests.');
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: '/tpaccept fails cleanly when the requester left',
    module: MODULE,
    now: NOW,
    otherPlayers: [{ ...BOB, online: false }],
    setup: function () {
      seedIncoming(this, 0, 'to');
    },
    test: async function () {
      const res = await this.runCommand('tpaccept');
      expect(this.userError(res)).to.equal('Bob is no longer online.');
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
      expect(requestRows(this)).to.have.length(0);
    },
  }),

  createModuleTest({
    name: 'a failed teleport (game without teleport support) charges nobody and starts no cooldown',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [{ ...BOB, currency: 50 }],
    userConfig: { cost: 20, cooldown: 60_000 },
    setup: function () {
      seedIncoming(this, 0, 'to');
      this.client.stubs.gameserver.gameServerControllerTeleportPlayer?.callsFake(async () => {
        throw new Error('Request failed with status code 400');
      });
    },
    test: async function () {
      const bob = this.otherPlayers[0]!;
      const res = await this.runCommand('tpaccept');
      expect(this.userError(res)).to.equal(
        'Teleport failed. This server may not support teleporting players. Nobody was charged.',
      );
      expect(this.client.pmsTo(bob.pog.gameId)).to.deep.equal([
        'Teleport failed. This server may not support teleporting players. Nobody was charged.',
      ]);
      expect(this.currency.balanceOf(bob.pog.playerId)).to.equal(50);
      expect((this.variables.all as Row[]).some((r) => r.key === 'tpa_cooldown')).to.equal(false);
    },
  }),

  createModuleTest({
    name: '/tpaccept refuses when the requester can no longer pay',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [{ ...BOB, currency: 1 }],
    userConfig: { cost: 20 },
    setup: function () {
      seedIncoming(this, 0, 'to');
    },
    test: async function () {
      const res = await this.runCommand('tpaccept');
      expect(this.userError(res)).to.equal('Bob can no longer pay for the teleport.');
      expect(this.client.pmsTo(this.otherPlayers[0]!.pog.gameId)).to.deep.equal([
        'Alice accepted, but you need 20 to teleport and have 1.',
      ]);
      expect(this.client.stubs.gameserver.gameServerControllerTeleportPlayer).to.not.have.been.called;
    },
  }),

  createModuleTest({
    name: '/tpdeny removes the request and tells the requester',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [BOB],
    setup: function () {
      seedIncoming(this, 0, 'to');
    },
    test: async function () {
      const res = await this.runCommand('tpdeny');
      expect(res.success, JSON.stringify(res.logs)).to.be.true;
      expect(requestRows(this)).to.have.length(0);
      expect(this.pms()).to.deep.equal(['Denied the request from Bob.']);
      expect(this.client.pmsTo(this.otherPlayers[0]!.pog.gameId)).to.deep.equal(['Alice denied your teleport request.']);
    },
  }),

  createModuleTest({
    name: '/tpblock drops a pending request and stops new ones; /tpunblock lifts it',
    module: MODULE,
    now: NOW,
    player: ME,
    otherPlayers: [BOB],
    setup: function () {
      seedIncoming(this, 0, 'to');
    },
    test: async function () {
      const bob = this.otherPlayers[0]!;
      const block = await this.runCommand('tpblock', { player: bob.pog });
      expect(block.success, JSON.stringify(block.logs)).to.be.true;
      expect(requestRows(this)).to.have.length(0);
      const blocks = (this.variables.all as Row[]).find((r) => r.key === 'tpa_blocks');
      expect(JSON.parse(blocks!.value)).to.deep.equal([{ id: bob.pog.playerId, name: 'Bob' }]);

      const again = await this.runCommand('tpblock', { player: bob.pog });
      expect(this.userError(again)).to.equal('Bob is already blocked.');

      const unblock = await this.runCommand('tpunblock', { player: bob.pog });
      expect(unblock.success, JSON.stringify(unblock.logs)).to.be.true;
      expect(this.pms()).to.deep.equal([
        'Blocked teleport requests from Bob.',
        'Bob can send you teleport requests again.',
      ]);
      const notBlocked = await this.runCommand('tpunblock', { player: bob.pog });
      expect(this.userError(notBlocked)).to.equal('Bob is not blocked.');
    },
  }),

  createModuleTest({
    name: '/tpa to a player who blocked you is refused',
    module: MODULE,
    now: NOW,
    permissions: USE,
    otherPlayers: [BOB],
    setup: function () {
      this.variables.insert({
        key: 'tpa_blocks',
        value: JSON.stringify([{ id: this.pog.playerId, name: 'x' }]),
        playerId: this.otherPlayers[0]!.pog.playerId,
        gameServerId: this.gameServerId,
        moduleId: this.moduleId,
      });
    },
    test: async function () {
      const res = await this.runCommand('tpa', { player: this.otherPlayers[0]!.pog });
      expect(this.userError(res)).to.equal('Bob is not accepting teleport requests from you.');
      expect(requestRows(this)).to.have.length(0);
    },
  }),
];

describe(group, function () {
  tests.forEach((test) => {
    test.run();
  });
});
