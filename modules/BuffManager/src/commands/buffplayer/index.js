import { data, takaro, TakaroUserError } from '@takaro/helpers';

async function main() {
    const { gameServerId, pog, arguments: args, module, player } = data;

    console.log(`⚡ /buffplayer command executed by ${player?.name || pog.gameId}`);

    const config = module.userConfig;
    const buffPackages = config.buffPackages || [];

    if (buffPackages.length === 0) {
        console.log('❌ No buff packages configured');
        throw new TakaroUserError('No buff packages are configured.');
    }

    const targetPlayerName = args.playerName?.trim() || '';
    const packageName = args.packageName?.trim() || '';

    if (!targetPlayerName) {
        console.log('❌ No player name provided');
        throw new TakaroUserError('Please specify a player name.');
    }

    if (!packageName) {
        console.log('❌ No package name provided');
        throw new TakaroUserError('Please specify a buff package name or "all".');
    }

    const playersRes = await takaro.gameserver.gameServerControllerGetPlayers(gameServerId);
    const onlinePlayers = playersRes.data.data || [];

    console.log(`   Found ${onlinePlayers.length} online player(s)`);

    const targetOnlinePlayer = onlinePlayers.find(p =>
        p.name.toLowerCase().includes(targetPlayerName.toLowerCase())
    );

    if (!targetOnlinePlayer) {
        console.log(`❌ Player "${targetPlayerName}" not found or not online`);
        throw new TakaroUserError(`Player "${targetPlayerName}" not found or not online.`);
    }

    console.log(`👤 Target player: ${targetOnlinePlayer.name}`);

    const targetPlayerRes = await takaro.player.playerControllerSearch({
        filters: {
            steamId: [targetOnlinePlayer.steamId]
        },
        limit: 1
    });

    if (!targetPlayerRes.data.data || targetPlayerRes.data.data.length === 0) {
        console.log(`❌ Player not found in Takaro database`);
        throw new TakaroUserError(`Player not found in Takaro database.`);
    }

    const targetPlayer = targetPlayerRes.data.data[0];
    console.log(`   Target player ID: ${targetPlayer.id}`);

    // Check if user wants to apply ALL packages
    if (packageName.toLowerCase() === 'all') {
        console.log(`💉 Applying ALL buff packages (${buffPackages.length} packages)`);

        let totalBuffsApplied = 0;
        let packagesProcessed = 0;

        for (const pkg of buffPackages) {
            console.log(`\n📦 Processing package: ${pkg.displayName}`);

            const buffNames = pkg.buffNames || [];
            console.log(`   Contains ${buffNames.length} buff(s): ${buffNames.join(', ')}`);

            const buffCommands = buffNames.map(buffName =>
                takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
                    command: `buffplayer "${targetOnlinePlayer.name}" ${buffName}`
                })
                    .then((response) => {
                        const serverResponse = response.data.data?.rawResult || 'No response';
                        console.log(`   ✓ Applied ${buffName}`);
                        console.log(`      Server response: ${serverResponse}`);
                        return { success: true, buff: buffName };
                    })
                    .catch(err => {
                        console.error(`   ❌ Failed to apply ${buffName}:`, err.message);
                        return { success: false, buff: buffName };
                    })
            );

            const results = await Promise.all(buffCommands);
            const successCount = results.filter(r => r && r.success).length;
            totalBuffsApplied += successCount;
            packagesProcessed++;

            console.log(`   ✅ Applied ${successCount}/${buffNames.length} buffs from this package`);

            if (Number(pkg.duration) > 0) {
                const expiryKey = `buff_expiry_${pkg.commandName}`;
                const expiryTime = Date.now() + (Number(pkg.duration) * 60000);

                try {
                    const existingVars = await takaro.variable.variableControllerSearch({
                        filters: {
                            key: [expiryKey],
                            playerId: [targetPlayer.id],
                            gameServerId: [gameServerId],
                            moduleId: [module.moduleId]
                        }
                    });

                    const minutes = Math.floor(Number(pkg.duration));
                    const hours = Math.floor(minutes / 60);
                    const timeStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

                    if (existingVars.data.data.length > 0) {
                        await takaro.variable.variableControllerUpdate(existingVars.data.data[0].id, {
                            value: expiryTime.toString()
                        });
                        console.log(`   ⏰ Expiration updated for ${pkg.commandName}: ${timeStr}`);
                    } else {
                        await takaro.variable.variableControllerCreate({
                            key: expiryKey,
                            value: expiryTime.toString(),
                            playerId: targetPlayer.id,
                            gameServerId: gameServerId,
                            moduleId: module.moduleId
                        });
                        console.log(`   ⏰ Expiration set for ${pkg.commandName}: ${timeStr}`);
                    }
                } catch (err) {
                    console.error(`   ⚠️ Failed to set expiration variable for ${pkg.commandName}:`, err.message);
                }
            } else {
                console.log(`   ⏰ No expiration for ${pkg.commandName} (permanent)`);
            }
        }

        console.log(`\n✅ Complete: Applied ${totalBuffsApplied} total buffs across ${packagesProcessed} packages`);
        await pog.pm(`Applied ALL buff packages to ${targetOnlinePlayer.name}! (${totalBuffsApplied} buffs applied)`);
        return;
    }

    // Apply specific package
    const pkg = buffPackages.find(p => p.commandName.toLowerCase() === packageName.toLowerCase());

    if (!pkg) {
        console.log(`❌ Package "${packageName}" not found`);
        const availablePackages = buffPackages.map(p => p.commandName).join(', ');
        throw new TakaroUserError(`Buff package "${packageName}" not found. Available: ${availablePackages}. Use "all" to apply all packages.`);
    }

    console.log(`🎯 Found package: ${pkg.displayName}`);

    const buffNames = pkg.buffNames || [];
    console.log(`💉 Applying ${buffNames.length} buff(s): ${buffNames.join(', ')}`);

    const buffCommands = buffNames.map(buffName =>
        takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
            command: `buffplayer "${targetOnlinePlayer.name}" ${buffName}`
        })
            .then((response) => {
                const serverResponse = response.data.data?.rawResult || 'No response';
                console.log(`   ✓ Applied ${buffName}`);
                console.log(`      Server response: ${serverResponse}`);
                return { success: true, buff: buffName };
            })
            .catch(err => {
                console.error(`   ❌ Failed to apply ${buffName}:`, err.message);
                return { success: false, buff: buffName };
            })
    );

    const results = await Promise.all(buffCommands);
    const successCount = results.filter(r => r && r.success).length;

    console.log(`✅ Applied ${successCount}/${buffNames.length} buffs successfully`);

    if (Number(pkg.duration) > 0) {
        const expiryKey = `buff_expiry_${pkg.commandName}`;
        const expiryTime = Date.now() + (Number(pkg.duration) * 60000);

        try {
            const existingVars = await takaro.variable.variableControllerSearch({
                filters: {
                    key: [expiryKey],
                    playerId: [targetPlayer.id],
                    gameServerId: [gameServerId],
                    moduleId: [module.moduleId]
                }
            });

            const minutes = Math.floor(Number(pkg.duration));
            const hours = Math.floor(minutes / 60);
            const timeStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

            if (existingVars.data.data.length > 0) {
                await takaro.variable.variableControllerUpdate(existingVars.data.data[0].id, {
                    value: expiryTime.toString()
                });
                console.log(`⏰ Expiration updated: ${timeStr}`);
            } else {
                await takaro.variable.variableControllerCreate({
                    key: expiryKey,
                    value: expiryTime.toString(),
                    playerId: targetPlayer.id,
                    gameServerId: gameServerId,
                    moduleId: module.moduleId
                });
                console.log(`⏰ Expiration set: ${timeStr}`);
            }
        } catch (err) {
            console.error(`⚠️ Failed to set expiration variable:`, err.message);
        }
    } else {
        console.log(`⏰ No expiration (permanent buff)`);
    }

    // Format expiry message
    let expiryMsg = '';
    if (Number(pkg.duration) > 0) {
        const minutes = Math.floor(Number(pkg.duration));
        const hours = Math.floor(minutes / 60);
        expiryMsg = hours > 0
            ? ` (expires in ${hours}h ${minutes % 60}m)`
            : ` (expires in ${minutes}m)`;
    }

    await pog.pm(`Applied ${pkg.displayName} to ${targetOnlinePlayer.name}!${expiryMsg}`);
    console.log('✅ Command complete');
}

await main();