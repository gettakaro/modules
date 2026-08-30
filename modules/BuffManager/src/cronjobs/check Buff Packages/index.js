import { data, takaro } from '@takaro/helpers';

function get7dtdCommandTarget(pog, onlinePlayer) {
    if (pog?.gameId) return String(pog.gameId).startsWith('EOS_') ? pog.gameId : `EOS_${pog.gameId}`;
    return JSON.stringify(onlinePlayer.name);
}

async function main() {
    const { gameServerId, module } = data;

    const config = module.userConfig;
    const buffPackages = config.buffPackages || [];

    console.log(`🔄 Buff Expiration Check & Maintenance starting...`);

    if (!config.maintenanceEnabled) {
        console.log('⏸️  Maintenance is DISABLED in config - skipping');
        return;
    }

    if (buffPackages.length === 0) {
        console.log('⚠️ No buff packages configured');
        return;
    }

    console.log(`   Configured packages: ${buffPackages.map(p => p.displayName).join(', ')}`);

    // Statistics tracking
    const stats = {
        playersProcessed: 0,
        buffPackagesMaintained: 0,
        buffPackagesExpiredAndRemoved: 0,
        totalBuffsReapplied: 0,
        errors: 0
    };

    try {
        // Get online PlayerOnGameServer records directly. This is more reliable for 7D2D
        // than mapping game-server player output through steamId, because 7D2D players may
        // only have gameId/platformId in the online-player payload.
        const pogsRes = await takaro.playerOnGameserver.playerOnGameServerControllerSearch({
            filters: {
                gameServerId: [gameServerId],
                online: [true]
            },
            extend: ['player'],
            limit: 100
        });
        const onlinePogs = pogsRes.data.data || [];

        console.log(`
👥 Found ${onlinePogs.length} online player(s)`);

        if (onlinePogs.length === 0) {
            console.log('   No players online - nothing to do');
            return;
        }

        const validPlayers = onlinePogs.map(pog => {
            const takaroPlayer = pog.player || { id: pog.playerId, name: pog.name || pog.gameId };
            const onlinePlayer = {
                name: takaroPlayer.name || pog.name || pog.gameId,
                gameId: pog.gameId
            };
            return { onlinePlayer, takaroPlayer, pog };
        }).filter(result => result.takaroPlayer && result.takaroPlayer.id);

        console.log(`\n🔍 Processing ${validPlayers.length} player(s)...\n`);

        // Process each player
        for (const { onlinePlayer, takaroPlayer, pog } of validPlayers) {
            console.log(`\n👤 Player: ${onlinePlayer.name}`);
            stats.playersProcessed++;

            try {
                const playerRoles = pog.roles || [];
                const playerRoleIds = playerRoles.map(r => r.role.id);
                console.log(`   Roles: ${playerRoleIds.length > 0 ? playerRoleIds.join(', ') : 'none'}`);

                // Get all buff expiration variables for this player
                console.log(`   🔍 Searching for variables with filters:`);
                console.log(`      - playerId: ${takaroPlayer.id}`);
                console.log(`      - gameServerId: ${gameServerId}`);
                console.log(`      - moduleId: ${module.moduleId}`);

                const variablesRes = await takaro.variable.variableControllerSearch({
                    filters: {
                        playerId: [takaroPlayer.id],
                        gameServerId: [gameServerId],
                        moduleId: [module.moduleId]
                    }
                });

                const variables = variablesRes.data.data || [];
                console.log(`   📦 Total variables found: ${variables.length}`);
                if (variables.length > 0) {
                    console.log(`   📝 Variable keys: ${variables.map(v => v.key).join(', ')}`);
                }

                const expiryVariables = variables.filter(v => v.key.startsWith('buff_expiry_'));
                console.log(`   ⏰ Active buff tracking variables: ${expiryVariables.length}`);

                if (expiryVariables.length === 0) {
                    console.log(`   No active buffs to check/maintain`);
                    continue;
                }

                // Check each buff package variable
                for (const variable of expiryVariables) {
                    const commandName = variable.key.replace('buff_expiry_', '');
                    const pkg = buffPackages.find(p => p.commandName === commandName);

                    if (!pkg) {
                        console.log(`\n   ⚠️  Package "${commandName}" no longer exists in config`);
                        console.log(`      🗑️  Cleaning up orphaned variable`);
                        try {
                            await takaro.variable.variableControllerDelete(variable.id);
                            console.log(`      ✓ Deleted orphaned variable`);
                        } catch (err) {
                            console.log(`      ⚠️  Failed to delete: ${err.message}`);
                        }
                        continue;
                    }

                    console.log(`\n   📦 Package: ${pkg.displayName}`);

                    try {
                        // STEP 1: Check if expired
                        const expiryTime = parseInt(variable.value);
                        const now = Date.now();
                        const isExpired = Number(pkg.duration) > 0 && expiryTime > 0 && now > expiryTime;

                        // Debug logging
                        console.log(`      📅 Debug: Expiry=${expiryTime === 0 ? 'permanent' : new Date(expiryTime).toISOString()}, Now=${new Date(now).toISOString()}, Duration=${pkg.duration}m`);
                        console.log(`      🔍 Expired check: ${isExpired} (now ${now} > expiry ${expiryTime})`)

                        if (isExpired) {
                            const msExpired = now - expiryTime;
                            const minutesExpired = Math.floor(msExpired / 60000);
                            const hoursExpired = Math.floor(msExpired / 3600000);

                            const expiredTimeStr = hoursExpired > 0
                                ? `${hoursExpired}h ${minutesExpired % 60}m`
                                : `${minutesExpired}m`;

                            console.log(`      ⏰ EXPIRED ${expiredTimeStr} ago`);
                            console.log(`      🗑️  Removing expired buffs from player`);

                            // Remove the actual buffs from the player
                            const buffNames = pkg.buffNames || [];
                            console.log(`      💊 Removing ${buffNames.length} buff(s): ${buffNames.join(', ')}`);
                            const commandTarget = get7dtdCommandTarget(pog, onlinePlayer);

                            const debuffCommands = buffNames.map(buffName =>
                                takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
                                    command: `debuffplayer ${commandTarget} ${buffName}`
                                })
                                    .then(() => {
                                        console.log(`         ✓ Removed ${buffName}`);
                                        return { success: true };
                                    })
                                    .catch(err => {
                                        console.error(`         ❌ Failed to remove ${buffName}: ${err.message}`);
                                        return { success: false };
                                    })
                            );

                            const removeResults = await Promise.all(debuffCommands);
                            const removedCount = removeResults.filter(r => r.success).length;
                            console.log(`      ✅ Removed ${removedCount}/${buffNames.length} buffs from player`);

                            // Send expiration notification to player
                            if (removedCount > 0) {
                                try {
                                    await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
                                        message: `⏰ ${pkg.displayName} has expired and been removed.`,
                                        opts: {
                                            recipient: {
                                                gameId: pog.gameId
                                            }
                                        }
                                    });
                                    console.log(`      📬 Expiration notification sent to player`);
                                } catch (err) {
                                    console.log(`      ⚠️  Failed to send notification: ${err.message}`);
                                }
                            }

                            // Clean up expired variable
                            try {
                                await takaro.variable.variableControllerDelete(variable.id);
                                stats.buffPackagesExpiredAndRemoved++;
                                console.log(`      ✓ Tracking variable deleted`);
                            } catch (err) {
                                console.log(`      ⚠️  Failed to delete variable: ${err.message}`);
                                stats.errors++;
                            }
                            continue; // Don't re-apply expired buffs
                        }

                        // STEP 2: Check if player still has required role
                        if (pkg.requiredRoleId && pkg.requiredRoleId.trim() !== '') {
                            const hasRole = playerRoleIds.includes(pkg.requiredRoleId);

                            if (!hasRole) {
                                console.log(`      🔍 Player no longer has required role`);
                                console.log(`      ⏭️  Skipping (won't re-apply)`);
                                continue;
                            }
                        }

                        // STEP 3: Calculate time remaining (for active buffs)
                        if (Number(pkg.duration) > 0) {
                            const msRemaining = expiryTime - now;
                            const minutesRemaining = Math.floor(msRemaining / 60000);
                            const hoursRemaining = Math.floor(msRemaining / 3600000);

                            const remainingTimeStr = hoursRemaining > 0
                                ? `${hoursRemaining}h ${minutesRemaining % 60}m`
                                : `${minutesRemaining}m`;

                            console.log(`      ⏰ Active - Expires in ${remainingTimeStr}`);
                        } else {
                            console.log(`      ⏰ Active - Permanent tracking`);
                        }

                        // STEP 4: Re-apply active buffs to maintain them
                        const buffNames = pkg.buffNames || [];
                        console.log(`      💉 Re-applying ${buffNames.length} buff(s): ${buffNames.join(', ')}`);
                        const commandTarget = get7dtdCommandTarget(pog, onlinePlayer);

                        const buffCommands = buffNames.map(buffName =>
                            takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
                                command: `buffplayer ${commandTarget} ${buffName}`
                            })
                                .then(() => {
                                    console.log(`         ✓ Applied ${buffName}`);
                                    return { success: true };
                                })
                                .catch(err => {
                                    console.error(`         ❌ Failed ${buffName}: ${err.message}`);
                                    stats.errors++;
                                    return { success: false };
                                })
                        );

                        const results = await Promise.all(buffCommands);
                        const successCount = results.filter(r => r.success).length;

                        stats.totalBuffsReapplied += successCount;
                        stats.buffPackagesMaintained++;

                        console.log(`      ✅ Maintained ${successCount}/${buffNames.length} buffs`);
                    } catch (err) {
                        console.error(`      ❌ Error processing package ${pkg.displayName}:`, err.message);
                        stats.errors++;
                    }
                }
            } catch (err) {
                console.error(`   ❌ Error processing player ${onlinePlayer.name}:`, err.message);
                stats.errors++;
            }
        }
    } catch (err) {
        console.error(`❌ Fatal error in buff check & maintenance:`, err.message);
        stats.errors++;
    }

    // Print summary
    console.log(`\n✅ Buff Check & Maintenance Complete`);
    console.log(`📊 Summary:`);
    console.log(`   - Players processed: ${stats.playersProcessed}`);
    console.log(`   - Active buff packages maintained: ${stats.buffPackagesMaintained}`);
    console.log(`   - Expired buffs removed: ${stats.buffPackagesExpiredAndRemoved}`);
    console.log(`   - Total buffs re-applied: ${stats.totalBuffsReapplied}`);
    if (stats.errors > 0) {
        console.log(`   - Errors encountered: ${stats.errors} ⚠️`);
    }
}

await main();