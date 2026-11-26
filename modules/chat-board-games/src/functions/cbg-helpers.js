import { data, takaro, TakaroUserError } from '@takaro/helpers';

// One row per game (pending challenge or running game), scoped to the challenger: a player can be
// the challenger of at most one game, and is in at most one game at a time.
export const GAME_KEY = 'cbg_game';
// Rock-paper-scissors picks live in their own row per player, so two players picking at the same
// moment never overwrite each other's pick inside the shared game row.
export const RPS_KEY = 'cbg_rps';
// The cron job never writes the game row (a move could be lost). It remembers reminders here.
export const REMIND_KEY = 'cbg_remind';
export const STATS_KEY = 'cbg_stats';

const PAGE_SIZE = 100;

export const GAMES = {
  ttt: { id: 'ttt', name: 'tic-tac-toe', aliases: ['ttt', 'tictactoe', 'tic-tac-toe', 'xo', 'noughts'] },
  c4: { id: 'c4', name: 'connect-four', aliases: ['c4', 'connect4', 'connectfour', 'connect-four', 'four'] },
  rps: { id: 'rps', name: 'rock-paper-scissors', aliases: ['rps', 'rockpaperscissors', 'rock-paper-scissors'] },
};

const C4_ROWS = 6;
const C4_COLS = 7;
const RPS_PICKS = { r: 'rock', rock: 'rock', p: 'paper', paper: 'paper', s: 'scissors', scissors: 'scissors' };
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

// ---------- settings, config, chat ----------

export async function getSetting(key, gameServerId, fallback) {
  try {
    const res = await takaro.settings.settingsControllerGetOne(key, gameServerId);
    return res.data.data.value ?? fallback;
  } catch (err) {
    console.log(`chat-board-games: could not read setting ${key}: ${err}`);
    return fallback;
  }
}

export async function getTexts(gameServerId) {
  const [prefix, currency] = await Promise.all([
    getSetting('commandPrefix', gameServerId, '/'),
    getSetting('currencyName', gameServerId, 'coins'),
  ]);
  return { prefix, currency };
}

export function cfg(userConfig) {
  const c = userConfig ?? {};
  return {
    enabled: {
      ttt: c.enableTicTacToe !== false,
      c4: c.enableConnectFour !== false,
      rps: c.enableRockPaperScissors !== false,
    },
    maxBet: Number(c.maxBet ?? 1000),
    minBet: Number(c.minBet ?? 1),
    houseFeePercent: Number(c.houseFeePercent ?? 0),
    challengeTimeoutMinutes: Number(c.challengeTimeoutMinutes ?? 2),
    turnTimeoutMinutes: Number(c.turnTimeoutMinutes ?? 3),
    reminderMinutes: Number(c.reminderMinutes ?? 1),
    turnTimeoutAction: c.turnTimeoutAction === 'refund' ? 'refund' : 'forfeit',
    rpsBestOf: Number(c.rpsBestOf ?? 1),
    announceResults: c.announceResults !== false,
    leaderboardSize: Number(c.leaderboardSize ?? 5),
  };
}

/** Words after the trigger, read from the full chat line (Takaro hands text args over as 1 word). */
export function chatWords() {
  const msg = String(data.chatMessage?.msg ?? '').trim();
  return msg.split(/\s+/).slice(1).filter(Boolean);
}

export function findGame(word) {
  const w = String(word ?? '').toLowerCase();
  return Object.values(GAMES).find((g) => g.aliases.includes(w)) ?? null;
}

export function enabledGames(c) {
  return Object.values(GAMES).filter((g) => c.enabled[g.id]);
}

// ---------- messages ----------

export async function pmGameId(gameServerId, gameId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message, opts: { recipient: { gameId } } });
  } catch (err) {
    console.log(`chat-board-games: PM to ${gameId} failed: ${err}`);
  }
}

/** Sends lines one message each (7D2D shows no line breaks). */
export async function pmLines(gameServerId, gameId, lines) {
  for (const line of lines) await pmGameId(gameServerId, gameId, line);
}

export async function broadcast(gameServerId, message) {
  try {
    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, { message });
  } catch (err) {
    console.log(`chat-board-games: broadcast failed: ${err}`);
  }
}

// ---------- players ----------

export async function getOnlinePlayers(gameServerId) {
  const pogs = (
    await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [gameServerId], online: [true] },
      limit: PAGE_SIZE,
    })
  ).data.data;
  if (pogs.length === 0) return [];
  const players = (
    await takaro.player.playerControllerSearch({ filters: { id: pogs.map((p) => p.playerId) }, limit: PAGE_SIZE })
  ).data.data;
  const names = new Map(players.map((p) => [p.id, p.name]));
  return pogs.map((pog) => ({ id: pog.playerId, gameId: pog.gameId, name: names.get(pog.playerId) ?? pog.gameId, currency: pog.currency }));
}

/** Exact (case-insensitive) name first, then a unique partial match. */
export function pickByName(candidates, query, what) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) throw new TakaroUserError('Please give a player name.');
  const exact = candidates.filter((c) => String(c.name).toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = candidates.filter((c) => String(c.name).toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const names = partial.slice(0, 5).map((c) => c.name).join(', ');
    throw new TakaroUserError(`More than one player matches "${query}": ${names}. Please be more specific.`);
  }
  throw new TakaroUserError(`No ${what} matches "${query}".`);
}

// ---------- currency ----------

export async function addCurrency(gameServerId, playerId, amount) {
  if (!(amount > 0)) return true;
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, playerId, { currency: amount });
    return true;
  } catch (err) {
    console.log(`chat-board-games: could not pay ${amount} to ${playerId}: ${err}`);
    return false;
  }
}

/** Takes the stake. Returns false when the player cannot pay. */
export async function takeStake(gameServerId, playerId, amount) {
  if (!(amount > 0)) return true;
  try {
    await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, playerId, { currency: amount });
    return true;
  } catch (err) {
    console.log(`chat-board-games: could not take ${amount} from ${playerId}: ${err}`);
    return false;
  }
}

// ---------- variables ----------

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function searchAll(gameServerId, moduleId, key, playerId) {
  const filters = { key: [key], gameServerId: [gameServerId], moduleId: [moduleId] };
  if (playerId) filters.playerId = [playerId];
  const all = [];
  for (let page = 0; page < 50; page++) {
    const rows = (await takaro.variable.variableControllerSearch({ filters, limit: PAGE_SIZE, page })).data.data;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/** Every game row as { variable, game }. */
export async function listGames(gameServerId, moduleId) {
  const rows = await searchAll(gameServerId, moduleId, GAME_KEY);
  const out = [];
  for (const variable of rows) {
    const game = parseJson(variable.value);
    if (game && game.challengerId && game.opponentId) out.push({ variable, game });
  }
  return out;
}

export async function findGameOf(gameServerId, moduleId, playerId) {
  const all = await listGames(gameServerId, moduleId);
  return all.find(({ game }) => game.challengerId === playerId || game.opponentId === playerId) ?? null;
}

export async function createGame(gameServerId, moduleId, game) {
  await takaro.variable.variableControllerCreate({
    key: GAME_KEY,
    value: JSON.stringify(game),
    gameServerId,
    moduleId,
    playerId: game.challengerId,
  });
}

/** Writes the game row. Returns false when the row is gone (game ended or expired meanwhile). */
export async function saveGame(variable, game) {
  try {
    await takaro.variable.variableControllerUpdate(variable.id, { value: JSON.stringify(game) });
    return true;
  } catch (err) {
    console.log(`chat-board-games: game ${game.id} row is gone: ${err}`);
    return false;
  }
}

/** Removes the game row. The caller that removes it owns the ending; a second caller gets false. */
export async function claimEnd(variable) {
  try {
    await takaro.variable.variableControllerDelete(variable.id);
    return true;
  } catch (err) {
    console.log(`chat-board-games: game already ended by someone else (${err})`);
    return false;
  }
}

async function deleteRows(rows) {
  for (const r of rows) {
    try {
      await takaro.variable.variableControllerDelete(r.id);
    } catch {
      // already gone
    }
  }
}

export async function getRpsPick(gameServerId, moduleId, playerId, gameId) {
  const rows = await searchAll(gameServerId, moduleId, RPS_KEY, playerId);
  for (const r of rows) {
    const v = parseJson(r.value);
    if (v && v.gameId === gameId) return { row: r, pick: v };
  }
  return null;
}

export async function setRpsPick(gameServerId, moduleId, playerId, gameId, round, pick) {
  const rows = await searchAll(gameServerId, moduleId, RPS_KEY, playerId);
  const value = JSON.stringify({ gameId, round, pick });
  if (rows[0]) {
    await takaro.variable.variableControllerUpdate(rows[0].id, { value });
    await deleteRows(rows.slice(1));
  } else {
    await takaro.variable.variableControllerCreate({ key: RPS_KEY, value, gameServerId, moduleId, playerId });
  }
}

export async function clearGameExtras(gameServerId, moduleId, game) {
  for (const pid of [game.challengerId, game.opponentId]) {
    await deleteRows(await searchAll(gameServerId, moduleId, RPS_KEY, pid));
  }
  await deleteRows(await searchAll(gameServerId, moduleId, REMIND_KEY, game.challengerId));
}

export async function getReminder(gameServerId, moduleId, challengerId) {
  const rows = await searchAll(gameServerId, moduleId, REMIND_KEY, challengerId);
  return rows[0] ? { row: rows[0], value: parseJson(rows[0].value) } : null;
}

export async function setReminder(gameServerId, moduleId, challengerId, value) {
  const existing = await getReminder(gameServerId, moduleId, challengerId);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.row.id, { value: JSON.stringify(value) });
  } else {
    await takaro.variable.variableControllerCreate({
      key: REMIND_KEY,
      value: JSON.stringify(value),
      gameServerId,
      moduleId,
      playerId: challengerId,
    });
  }
}

// ---------- stats ----------

function emptyStats(name) {
  return { name, wins: 0, losses: 0, draws: 0, net: 0, games: {} };
}

export async function getStats(gameServerId, moduleId, playerId) {
  const rows = await searchAll(gameServerId, moduleId, STATS_KEY, playerId);
  return rows[0] ? { row: rows[0], stats: parseJson(rows[0].value) ?? emptyStats('') } : null;
}

export async function listStats(gameServerId, moduleId) {
  const rows = await searchAll(gameServerId, moduleId, STATS_KEY);
  return rows.map((r) => ({ playerId: r.playerId, stats: parseJson(r.value) })).filter((r) => r.stats);
}

/** result: 'win' | 'loss' | 'draw'; net: currency won (+) or lost (-). */
export async function recordStats(gameServerId, moduleId, playerId, name, gameId, result, net) {
  const existing = await getStats(gameServerId, moduleId, playerId);
  const stats = existing ? existing.stats : emptyStats(name);
  stats.name = name;
  const field = result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws';
  stats[field] = (stats[field] ?? 0) + 1;
  stats.net = (stats.net ?? 0) + net;
  stats.games = stats.games ?? {};
  const g = stats.games[gameId] ?? { wins: 0, losses: 0, draws: 0 };
  g[field] = (g[field] ?? 0) + 1;
  stats.games[gameId] = g;
  const value = JSON.stringify(stats);
  if (existing) {
    await takaro.variable.variableControllerUpdate(existing.row.id, { value });
  } else {
    await takaro.variable.variableControllerCreate({ key: STATS_KEY, value, gameServerId, moduleId, playerId });
  }
}

// ---------- boards ----------

export function newBoard(gameId) {
  if (gameId === 'ttt') return Array(9).fill('');
  if (gameId === 'c4') return Array(C4_ROWS * C4_COLS).fill('');
  return null;
}

export function renderBoard(game) {
  const b = game.board;
  if (game.game === 'ttt') {
    const lines = [];
    for (let r = 0; r < 3; r++) {
      lines.push([0, 1, 2].map((c) => b[r * 3 + c] || String(r * 3 + c + 1)).join(' | '));
    }
    return lines;
  }
  if (game.game === 'c4') {
    const lines = [];
    for (let r = 0; r < C4_ROWS; r++) {
      const cells = [];
      for (let c = 0; c < C4_COLS; c++) cells.push(b[r * C4_COLS + c] || '.');
      lines.push(`|${cells.join('|')}|`);
    }
    lines.push(` ${Array.from({ length: C4_COLS }, (_, i) => i + 1).join(' ')}`);
    return lines;
  }
  return [];
}

const TTT_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/** Returns 'X' | 'O' | 'draw' | null. */
export function boardResult(game) {
  const b = game.board;
  if (game.game === 'ttt') {
    for (const [a, c, d] of TTT_LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    return b.every(Boolean) ? 'draw' : null;
  }
  if (game.game === 'c4') {
    const at = (r, c) => (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS ? b[r * C4_COLS + c] : '');
    for (let r = 0; r < C4_ROWS; r++) {
      for (let c = 0; c < C4_COLS; c++) {
        const v = at(r, c);
        if (!v) continue;
        for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
          if (v === at(r + dr, c + dc) && v === at(r + 2 * dr, c + 2 * dc) && v === at(r + 3 * dr, c + 3 * dc)) return v;
        }
      }
    }
    return b.every(Boolean) ? 'draw' : null;
  }
  return null;
}

/** Applies a move for `mark`. Returns an error text, or null when the move was made. */
export function applyMove(game, mark, word) {
  const n = Number(word);
  if (game.game === 'ttt') {
    if (!Number.isInteger(n) || n < 1 || n > 9) return 'Pick a free square from 1 to 9.';
    if (game.board[n - 1]) return `Square ${n} is taken. Pick a free square.`;
    game.board[n - 1] = mark;
    game.lastMove = String(n);
    return null;
  }
  if (game.game === 'c4') {
    if (!Number.isInteger(n) || n < 1 || n > C4_COLS) return `Pick a column from 1 to ${C4_COLS}.`;
    const c = n - 1;
    for (let r = C4_ROWS - 1; r >= 0; r--) {
      if (!game.board[r * C4_COLS + c]) {
        game.board[r * C4_COLS + c] = mark;
        game.lastMove = `column ${n}`;
        return null;
      }
    }
    return `Column ${n} is full. Pick another column.`;
  }
  return 'Unknown game.';
}

export function parseRpsPick(word) {
  return RPS_PICKS[String(word ?? '').toLowerCase()] ?? null;
}

/** 1 = a wins, -1 = b wins, 0 = draw. */
export function rpsCompare(a, b) {
  if (a === b) return 0;
  return RPS_BEATS[a] === b ? 1 : -1;
}

export function moveHint(game, prefix) {
  if (game.game === 'ttt') return `${prefix}move <1-9>`;
  if (game.game === 'c4') return `${prefix}move <column 1-7>`;
  return `${prefix}move rock, paper or scissors`;
}

// ---------- game helpers ----------

export function side(game, playerId) {
  if (game.challengerId === playerId) {
    return { mark: game.challengerMark, me: 'challenger', other: { id: game.opponentId, name: game.opponentName, gameId: game.opponentGameId } };
  }
  return { mark: game.challengerMark === 'X' ? 'O' : 'X', me: 'opponent', other: { id: game.challengerId, name: game.challengerName, gameId: game.challengerGameId } };
}

export function playerByMark(game, mark) {
  return mark === game.challengerMark
    ? { id: game.challengerId, name: game.challengerName, gameId: game.challengerGameId }
    : { id: game.opponentId, name: game.opponentName, gameId: game.opponentGameId };
}

export function gameName(game) {
  return GAMES[game.game]?.name ?? game.game;
}

export function potText(game, currency) {
  return game.bet > 0 ? ` Pot: ${game.bet * 2} ${currency}.` : '';
}

export function minutesSince(iso, now = Date.now()) {
  return (now - new Date(iso).getTime()) / 60000;
}

/** Prints the board to one player, then a status line. */
export async function sendBoard(gameServerId, game, toGameId, statusLine) {
  const lines = [...renderBoard(game)];
  if (statusLine) lines.push(statusLine);
  await pmLines(gameServerId, toGameId, lines);
}

/** Both players' turn lines after a board change. */
export async function announceTurn(gameServerId, game, prefix) {
  const turnPlayer = playerByMark(game, game.turn);
  const waiting = playerByMark(game, game.turn === 'X' ? 'O' : 'X');
  await sendBoard(gameServerId, game, turnPlayer.gameId, `Your turn (${game.turn}) vs ${waiting.name}: ${moveHint(game, prefix)}`);
  await sendBoard(gameServerId, game, waiting.gameId, `Waiting for ${turnPlayer.name} (${game.turn}).`);
}

/**
 * Ends a game that the caller already claimed with claimEnd().
 * outcome: { winnerId } | { draw: true } | { refund: true, reason }
 */
export async function finishGame(gameServerId, mod, game, outcome, texts) {
  const c = cfg(mod.userConfig);
  const { currency } = texts;
  const players = [
    { id: game.challengerId, name: game.challengerName, gameId: game.challengerGameId },
    { id: game.opponentId, name: game.opponentName, gameId: game.opponentGameId },
  ];
  const name = gameName(game);
  const bet = Number(game.bet) || 0;
  const accepted = game.status === 'active';

  if (outcome.refund) {
    // outcome.messages: { challenger, opponent } texts; a player who staked gets the refund note.
    await addCurrency(gameServerId, game.challengerId, bet);
    if (accepted) await addCurrency(gameServerId, game.opponentId, bet);
    const refundText = bet > 0 ? ` Your ${bet} ${currency} stake was refunded.` : '';
    const msgs = outcome.messages ?? {};
    if (msgs.challenger) await pmGameId(gameServerId, game.challengerGameId, `${msgs.challenger}${refundText}`);
    if (msgs.opponent) await pmGameId(gameServerId, game.opponentGameId, `${msgs.opponent}${accepted ? refundText : ''}`);
    await clearGameExtras(gameServerId, mod.moduleId, game);
    return;
  }

  if (outcome.draw) {
    await addCurrency(gameServerId, game.challengerId, bet);
    await addCurrency(gameServerId, game.opponentId, bet);
    const refundText = bet > 0 ? ` Stakes refunded (${bet} ${currency} each).` : '';
    for (const p of players) {
      if (game.board) await sendBoard(gameServerId, game, p.gameId, null);
      await pmGameId(gameServerId, p.gameId, `Draw! ${game.challengerName} and ${game.opponentName} tied at ${name}.${refundText}`);
    }
    for (const p of players) await recordStats(gameServerId, mod.moduleId, p.id, p.name, game.game, 'draw', 0);
    if (c.announceResults) await broadcast(gameServerId, `${game.challengerName} and ${game.opponentName} drew at ${name}.`);
    await clearGameExtras(gameServerId, mod.moduleId, game);
    return;
  }

  const winner = players.find((p) => p.id === outcome.winnerId);
  const loser = players.find((p) => p.id !== outcome.winnerId);
  const pot = bet * 2;
  const fee = Math.floor((pot * Math.max(0, Math.min(100, c.houseFeePercent))) / 100);
  const prize = pot - fee;
  const paid = prize > 0 ? await addCurrency(gameServerId, winner.id, prize) : true;
  const why = outcome.reason ? ` (${outcome.reason})` : '';
  const prizeText = prize > 0 ? ` and won ${prize} ${currency}` : '';
  const feeText = fee > 0 ? ` (${fee} ${currency} house fee)` : '';

  for (const p of players) {
    if (game.board) await sendBoard(gameServerId, game, p.gameId, null);
  }
  await pmGameId(gameServerId, winner.gameId, `You beat ${loser.name} at ${name}${why}${prizeText}${feeText}!`);
  await pmGameId(gameServerId, loser.gameId, `${winner.name} beat you at ${name}${why}.${bet > 0 ? ` You lost your ${bet} ${currency} stake.` : ''}`);
  if (!paid) await pmGameId(gameServerId, winner.gameId, 'Paying the prize failed. Please tell an admin.');

  await recordStats(gameServerId, mod.moduleId, winner.id, winner.name, game.game, 'win', prize - bet);
  await recordStats(gameServerId, mod.moduleId, loser.id, loser.name, game.game, 'loss', -bet);
  if (c.announceResults) await broadcast(gameServerId, `${winner.name} beat ${loser.name} at ${name}${why}${prizeText}.`);
  await clearGameExtras(gameServerId, mod.moduleId, game);
}
