import { data, takaro } from '@takaro/helpers';
import {
  readConfig, getMarketRow, parseMarket, findStock, listPortfolioRows, parsePortfolio, getDividendsRow, parseDividends,
  poolFrom, saveVar, broadcast, getServerTexts, formatAmount, DIVIDENDS_KEY,
} from './stx-helpers.js';

async function main() {
  const { gameServerId, module: mod } = data;
  const moduleId = mod.moduleId;
  const cfg = readConfig(mod.userConfig);
  const { currency, economyEnabled } = await getServerTexts(gameServerId);
  if (!economyEnabled) {
    console.log('stock-exchange: economy disabled, no dividends');
    return;
  }

  const market = parseMarket(await getMarketRow(gameServerId, moduleId));
  const rows = await listPortfolioRows(gameServerId, moduleId);
  const portfolios = rows.map((r) => ({ playerId: r.playerId, ...parsePortfolio(r) }));
  const divRow = await getDividendsRow(gameServerId, moduleId);
  const ledger = parseDividends(divRow);
  const { pool } = poolFrom(portfolios, ledger);
  const budget = Math.floor((pool * cfg.dividendPayoutPercent) / 100);
  if (budget < 1) {
    console.log(`stock-exchange: fee pool ${pool}, nothing to pay`);
    return;
  }

  const now = Date.now();
  const streakMs = cfg.holdStreakDays * 86400000;
  const holders = [];
  for (const p of portfolios) {
    let weight = 0;
    let bonus = false;
    for (const [id, h] of Object.entries(p.holdings)) {
      const stock = findStock(id, cfg, market);
      if (!stock || stock.delisted) continue;
      let w = stock.price * h.shares;
      if (cfg.holdStreakDays > 0 && h.holdSince && now - Date.parse(h.holdSince) >= streakMs) {
        w *= 1 + cfg.holdBonusPercent / 100;
        bonus = true;
      }
      weight += w;
    }
    if (weight > 0 && p.playerId) holders.push({ ...p, weight, bonus });
  }
  const totalWeight = holders.reduce((s, h) => s + h.weight, 0);
  if (totalWeight <= 0) {
    console.log('stock-exchange: no shareholders, the pool stays');
    return;
  }

  const payouts = holders
    .map((h) => ({ ...h, amount: Math.floor((budget * h.weight) / totalWeight) }))
    .filter((h) => h.amount > 0);
  const total = payouts.reduce((s, h) => s + h.amount, 0);
  if (total < 1) return;

  // Book the payout first, so a crash halfway can never pay the same pool twice.
  await saveVar(divRow, { gameServerId, moduleId }, DIVIDENDS_KEY, {
    paid: ledger.paid + total,
    runs: ledger.runs + 1,
    lastAt: new Date().toISOString(),
    lastAmount: total,
    lastHolders: payouts.length,
  });

  for (const h of payouts) {
    try {
      await takaro.playerOnGameserver.playerOnGameServerControllerAddCurrency(gameServerId, h.playerId, {
        currency: h.amount,
        reason: 'Stock dividend',
      });
    } catch (err) {
      console.error(`stock-exchange: dividend to ${h.playerId} failed: ${err}`);
      continue;
    }
    try {
      const pog = (await takaro.playerOnGameserver.playerOnGameServerControllerGetOne(gameServerId, h.playerId)).data.data;
      if (pog && pog.online && pog.gameId) {
        const bonusText = h.bonus ? ' Hold bonus included.' : '';
        await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
          message: `Stock dividend: +${formatAmount(h.amount)} ${currency} from the trade fee pool.${bonusText}`,
          opts: { recipient: { gameId: pog.gameId } },
        });
      }
    } catch (err) {
      console.log(`stock-exchange: could not PM dividend to ${h.playerId}: ${err}`);
    }
  }
  await broadcast(gameServerId, `Stock dividends paid: ${formatAmount(total)} ${currency} to ${payouts.length} shareholders.`);
}

await main();
