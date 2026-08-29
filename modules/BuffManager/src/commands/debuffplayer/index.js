import { data, takaro, TakaroUserError } from '@takaro/helpers';

async function main() {
    const { gameServerId, pog, arguments: args, module, player } = data;

    console.log(`⚡ /debuffplayer command executed by ${player?.name || pog.gameId}`);

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

    // Check if user wants to remove ALL packages
    if (packageName.toLowerCase() === 'all') {
        console.log(`💊 Removing ALL buff packages (${buffPackages.length} packages)`);

        let totalBuffsRemoved = 0;
        let packagesProcessed = 0;

        for (const pkg of buffPackages) {
            console.log(`\n📦 Processing package: ${pkg.displayName}`);

            const buffNames = pkg.buffNames || [];
            console.log(`   Contains ${buffNames.length} buff(s): ${buffNames.join(', ')}`);

            const debuffCommands = buffNames.map(buffName =>
                takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
                    command: `debuffplayer "${targetOnlinePlayer.name}" ${buffName}`
                })
                    .then((response) => {
                        const serverResponse = response.data.data?.rawResult || 'No response';
                        console.log(`   ✓ Removed ${buffName}`);
                        console.log(`      Server response: ${serverResponse}`);
                        return { success: true, buff: buffName };
                    })
                    .catch(err => {
                        console.error(`   ❌ Failed to remove ${buffName}:`, err.message);
                        return { success: false, buff: buffName };
                    })
            );

            const results = await Promise.all(debuffCommands);
            const successCount = results.filter(r => r && r.success).length;
            totalBuffsRemoved += successCount;
            packagesProcessed++;

            console.log(`   ✅ Removed ${successCount}/${buffNames.length} buffs from this package`);

            const expiryKey = `buff_expiry_${pkg.commandName}`;

            try {
                const existingVars = await takaro.variable.variableControllerSearch({
                    filters: {
                        key: [expiryKey],
                        playerId: [targetPlayer.id],
                        gameServerId: [gameServerId],
                        moduleId: [module.moduleId]
                    }
                });

                if (existingVars.data.data.length > 0) {
                    await takaro.variable.variableControllerDelete(existingVars.data.data[0].id);
                    console.log(`   ⏰ Expiration variable deleted for ${pkg.commandName}`);
                } else {
                    console.log(`   ⏰ No expiration variable found for ${pkg.commandName}`);
                }
            } catch (err) {
                console.error(`   ⚠️ Failed to delete expiration variable for ${pkg.commandName}:`, err.message);
            }
        }

        console.log(`\n✅ Complete: Removed ${totalBuffsRemoved} total buffs across ${packagesProcessed} packages`);
        await pog.pm(`Removed ALL buff packages from ${targetOnlinePlayer.name}! (${totalBuffsRemoved} buffs removed)`);
        return;
    }

    // Remove specific package
    const pkg = buffPackages.find(p => p.commandName.toLowerCase() === packageName.toLowerCase());

    if (!pkg) {
        console.log(`❌ Package "${packageName}" not found`);
        const availablePackages = buffPackages.map(p => p.commandName).join(', ');
        throw new TakaroUserError(`Buff package "${packageName}" not found. Available: ${availablePackages}. Use "all" to remove all packages.`);
    }

    console.log(`🎯 Found package: ${pkg.displayName}`);

    const buffNames = pkg.buffNames || [];
    console.log(`💊 Removing ${buffNames.length} buff(s): ${buffNames.join(', ')}`);

    const debuffCommands = buffNames.map(buffName =>
        takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
            command: `debuffplayer "${targetOnlinePlayer.name}" ${buffName}`
        })
            .then((response) => {
                const serverResponse = response.data.data?.rawResult || 'No response';
                console.log(`   ✓ Removed ${buffName}`);
                console.log(`      Server response: ${serverResponse}`);
                return { success: true, buff: buffName };
            })
            .catch(err => {
                console.error(`   ❌ Failed to remove ${buffName}:`, err.message);
                return { success: false, buff: buffName };
            })
    );

    const results = await Promise.all(debuffCommands);
    const successCount = results.filter(r => r && r.success).length;

    console.log(`✅ Removed ${successCount}/${buffNames.length} buffs successfully`);

    const expiryKey = `buff_expiry_${pkg.commandName}`;

    try {
        const existingVars = await takaro.variable.variableControllerSearch({
            filters: {
                key: [expiryKey],
                playerId: [targetPlayer.id],
                gameServerId: [gameServerId],
                moduleId: [module.moduleId]
            }
        });

        if (existingVars.data.data.length > 0) {
            await takaro.variable.variableControllerDelete(existingVars.data.data[0].id);
            console.log(`⏰ Expiration variable deleted`);
        } else {
            console.log(`⏰ No expiration variable found to delete`);
        }
    } catch (err) {
        console.error(`⚠️ Failed to delete expiration variable:`, err.message);
    }

    await pog.pm(`Removed ${pkg.displayName} from ${targetOnlinePlayer.name}!`);
    console.log('✅ Command complete');
}

await main();