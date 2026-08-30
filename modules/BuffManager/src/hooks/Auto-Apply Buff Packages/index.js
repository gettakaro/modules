import { data, takaro } from '@takaro/helpers';

function get7dtdCommandTarget(pog, player) {
    if (pog?.gameId) return String(pog.gameId).startsWith('EOS_') ? pog.gameId : `EOS_${pog.gameId}`;
    return `\"${player.name}\"`;
}

async function main() {
    const { gameServerId, eventData, player, pog, module } = data;

    if (!player) {
        console.log('❌ Error: Player data is undefined');
        return;
    }

    if (!pog) {
        console.log('❌ Error: Player-on-gameserver (pog) data is undefined');
        return;
    }

    console.log(`🔌 Player connected: ${player.name || 'Unknown'} (ID: ${player.id})`);

    const config = module.userConfig;
    const buffPackages = config.buffPackages || [];

    if (buffPackages.length === 0) {
        console.log('⚠️ No buff packages configured');
        return;
    }

    // Filter packages that should auto-apply
    const autoApplyPackages = buffPackages.filter(pkg => pkg.autoApplyOnConnect === true);

    if (autoApplyPackages.length === 0) {
        console.log('⚠️ No packages with auto-apply enabled');
        return;
    }

    console.log(`🔍 Checking ${autoApplyPackages.length} auto-apply package(s)`);

    const playerRoles = pog.roles || [];
    const playerRoleIds = playerRoles.map(r => r.role.id);

    console.log(`   Player has ${playerRoleIds.length} role(s)${playerRoleIds.length > 0 ? ': ' + playerRoleIds.join(', ') : ''}`);

    // Check each package for role requirements
    const eligiblePackages = autoApplyPackages.filter(pkg => {
        // If no role required, everyone is eligible
        if (!pkg.requiredRoleId || pkg.requiredRoleId.trim() === '') {
            console.log(`   ✓ ${pkg.displayName}: No role required - eligible`);
            return true;
        }

        // Check if player has the required role
        const hasRole = playerRoleIds.includes(pkg.requiredRoleId);
        const icon = hasRole ? '✓' : '✗';
        console.log(`   ${icon} ${pkg.displayName}: ${hasRole ? 'HAS' : 'MISSING'} role ${pkg.requiredRoleId}`);
        return hasRole;
    });

    if (eligiblePackages.length === 0) {
        console.log('⚠️ Player is not eligible for any auto-apply packages');
        return;
    }

    console.log(`\n💉 Applying ${eligiblePackages.length} buff package(s) to ${player.name}`);

    // Statistics
    const stats = {
        packagesApplied: 0,
        buffsTotalApplied: 0,
        packagesSkipped: 0,
        errors: 0
    };

    // Get existing buff variables to check what's already active
    let existingBuffVars = [];
    try {
        const varsRes = await takaro.variable.variableControllerSearch({
            filters: {
                playerId: [player.id],
                gameServerId: [gameServerId],
                moduleId: [module.moduleId]
            }
        });
        existingBuffVars = (varsRes.data.data || []).filter(v => v.key.startsWith('buff_expiry_'));
        console.log(`   Found ${existingBuffVars.length} existing buff variable(s)`);
    } catch (err) {
        console.log(`   ⚠️ Could not fetch existing variables: ${err.message}`);
    }

    // Apply each eligible package
    for (const pkg of eligiblePackages) {
        console.log(`\n📦 Processing package: ${pkg.displayName}`);

        try {
            // Check if this package is already active and not expired
            const expiryKey = `buff_expiry_${pkg.commandName}`;
            const existingVar = existingBuffVars.find(v => v.key === expiryKey);

            if (existingVar) {
                const expiryTime = parseInt(existingVar.value);
                const now = Date.now();
                const isPermanent = Number(pkg.duration) === 0 && expiryTime === 0;
                const isStillActive = isPermanent || expiryTime > now;

                if (isStillActive) {
                    if (isPermanent) {
                        console.log(`   ⏭️  Already active (permanent) - skipping`);
                    } else {
                        const msRemaining = expiryTime - now;
                        const minutesRemaining = Math.floor(msRemaining / 60000);
                        const hoursRemaining = Math.floor(msRemaining / 3600000);
                        const timeStr = hoursRemaining > 0
                            ? `${hoursRemaining}h ${minutesRemaining % 60}m`
                            : `${minutesRemaining}m`;
                        console.log(`   ⏭️  Already active (${timeStr} remaining) - skipping`);
                    }
                    stats.packagesSkipped++;
                    continue;
                }
            }

            const buffNames = pkg.buffNames || [];
            if (buffNames.length === 0) {
                console.log('   ⚠️ No buffs configured - skipping');
                stats.packagesSkipped++;
                continue;
            }

            console.log(`   Buffs to apply: ${buffNames.join(', ')}`);
            const commandTarget = get7dtdCommandTarget(pog, player);

            // Apply all buffs in this package in parallel
            const buffCommands = buffNames.map(buffName =>
                takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
                    command: `buffplayer ${commandTarget} ${buffName}`
                })
                    .then((response) => {
                        const serverResponse = response.data.data?.rawResult || 'No response';
                        console.log(`      ✓ Applied ${buffName}`);
                        return { success: true };
                    })
                    .catch(error => {
                        console.log(`      ✗ Failed to apply ${buffName}: ${error.message}`);
                        stats.errors++;
                        return { success: false };
                    })
            );

            const results = await Promise.all(buffCommands);
            const successCount = results.filter(r => r.success).length;

            console.log(`   ✅ Applied ${successCount}/${buffNames.length} buffs`);

            if (successCount > 0) {
                stats.packagesApplied++;
                stats.buffsTotalApplied += successCount;
            }

            // Set or update tracking. Duration 0 is permanent tracking for maintenance.
            try {
                const durationMinutes = Number(pkg.duration);
                const expiryTime = durationMinutes > 0 ? Date.now() + (durationMinutes * 60000) : 0;

                if (existingVar) {
                    await takaro.variable.variableControllerUpdate(existingVar.id, {
                        value: expiryTime.toString()
                    });
                } else {
                    await takaro.variable.variableControllerCreate({
                        key: expiryKey,
                        value: expiryTime.toString(),
                        playerId: player.id,
                        gameServerId: gameServerId,
                        moduleId: module.moduleId
                    });
                }

                if (durationMinutes > 0) {
                    const minutes = Math.floor(durationMinutes);
                    const hours = Math.floor(minutes / 60);
                    const timeStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
                    console.log(`   ⏰ Expiration ${existingVar ? 'updated' : 'set'}: ${timeStr}`);
                } else {
                    console.log(`   ⏰ Permanent tracking ${existingVar ? 'updated' : 'set'}`);
                }
            } catch (err) {
                console.log(`   ⚠️ Failed to set/update tracking: ${err.message}`);
                stats.errors++;
            }
        } catch (err) {
            console.log(`   ❌ Error processing package ${pkg.displayName}: ${err.message}`);
            stats.errors++;
        }
    }

    // Send welcome message if any buffs were applied
    if (stats.packagesApplied > 0) {
        try {
            const packageNames = eligiblePackages
                .filter(pkg => {
                    // Only include packages that weren't skipped
                    const expiryKey = `buff_expiry_${pkg.commandName}`;
                    const wasSkipped = existingBuffVars.find(v => v.key === expiryKey && (parseInt(v.value) === 0 || parseInt(v.value) > Date.now()));
                    return !wasSkipped;
                })
                .map(p => p.displayName)
                .join(', ');

            if (packageNames) {
                await takaro.gameserver.gameServerControllerSendMessage(gameServerId, {
                    message: `Welcome ${player.name}! Auto-applied buffs: ${packageNames}`,
                    opts: {
                        recipient: {
                            gameId: pog.gameId
                        }
                    }
                });
                console.log('\n✅ Welcome message sent');
            }
        } catch (error) {
            console.log(`\n⚠️ Failed to send welcome message: ${error.message}`);
        }
    }

    // Summary
    console.log('\n✅ Auto-apply complete');
    console.log(`📊 Summary:`);
    console.log(`   - Packages applied: ${stats.packagesApplied}`);
    console.log(`   - Packages skipped (already active): ${stats.packagesSkipped}`);
    console.log(`   - Total buffs applied: ${stats.buffsTotalApplied}`);
    if (stats.errors > 0) {
        console.log(`   - Errors: ${stats.errors} ⚠️`);
    }
}

await main();