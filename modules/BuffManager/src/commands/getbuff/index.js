import { data, takaro, checkPermission, TakaroUserError } from '@takaro/helpers';

async function main() {
    const { gameServerId, pog, arguments: args, module, player } = data;

    console.log(`⚡ /getbuff command executed by ${player?.name || pog.gameId}`);

    const config = module.userConfig;
    const buffPackages = config.buffPackages || [];

    if (buffPackages.length === 0) {
        console.log('❌ No buff packages configured');
        throw new TakaroUserError('No buff packages are configured. Please contact an administrator.');
    }

    const packageName = args.packageName?.trim() || '';

    // If no package specified, list available packages
    if (!packageName) {
        console.log('📋 Listing available buff packages');
        const availablePackages = buffPackages
            .map(pkg => {
                const cost = pkg.currencyCost > 0 ? ` (Cost: ${pkg.currencyCost})` : '';
                const role = pkg.requiredRoleId && pkg.requiredRoleId.trim() ? ' [Role Required]' : '';

                // Format duration stored in minutes
                let durationText = '';
                if (Number(pkg.duration) > 0) {
                    const minutes = Math.floor(Number(pkg.duration));
                    const hours = Math.floor(minutes / 60);
                    if (hours > 0) {
                        durationText = ` [Duration: ${hours}h ${minutes % 60}m]`;
                    } else {
                        durationText = ` [Duration: ${minutes}m]`;
                    }
                } else {
                    durationText = ' [Permanent]';
                }

                return `• ${pkg.commandName} - ${pkg.displayName}${cost}${role}${durationText}${pkg.description ? '\n  ' + pkg.description : ''}`;
            })
            .join('\n');

        await pog.pm(`Available buff packages:\n${availablePackages}\n\nUsage: getbuff <packageName>`);
        console.log('✅ Package list sent');
        return;
    }

    // Find the requested package
    const pkg = buffPackages.find(p => p.commandName.toLowerCase() === packageName.toLowerCase());

    if (!pkg) {
        console.log(`❌ Package "${packageName}" not found`);
        throw new TakaroUserError(`Buff package "${packageName}" not found. Use /getbuff to see available packages.`);
    }

    console.log(`🎯 Found package: ${pkg.displayName}`);

    // Check role requirement
    if (pkg.requiredRoleId && pkg.requiredRoleId.trim() !== '') {
        const playerRoles = pog.roles || [];
        const hasRole = playerRoles.some(r => r.role.id === pkg.requiredRoleId);

        console.log(`🔐 Role check: ${hasRole ? '✓ HAS' : '✗ NO'} required role ${pkg.requiredRoleId}`);

        if (!hasRole) {
            console.log('❌ Command denied - insufficient role');
            throw new TakaroUserError(`You don't have the required role to use this buff package.`);
        }
    } else {
        console.log('🔐 Role check: ✓ No role required');
    }

    // Handle currency cost
    let shouldChargeCurrency = false;
    if (Number(pkg.currencyCost) > 0) {
        const currentCurrency = Number(pog.currency || 0);
        const cost = Number(pkg.currencyCost);

        console.log(`💰 Currency check: ${currentCurrency} >= ${cost}`);

        if (currentCurrency < cost) {
            console.log('❌ Insufficient currency');
            let currencyName = 'currency';
            try {
                currencyName = (await takaro.settings.settingsControllerGetOne('currencyName', gameServerId)).data.data.value || currencyName;
            } catch (err) {
                console.log(`⚠️ Could not fetch currency name: ${err.message}`);
            }
            throw new TakaroUserError(`Insufficient ${currencyName}. Need ${cost}, have ${currentCurrency}.`);
        }

        shouldChargeCurrency = true;
    }

    const buffNames = pkg.buffNames || [];
    console.log(`💉 Applying ${buffNames.length} buff(s): ${buffNames.join(', ')}`);

    // Apply all buffs in parallel
    const buffCommands = buffNames.map(buffName =>
        takaro.gameserver.gameServerControllerExecuteCommand(gameServerId, {
            command: `buffplayer "${player.name}" ${buffName}`
        })
            .then((response) => {
                const serverResponse = response.data.data?.rawResult || 'No response';
                console.log(`   ✓ Applied ${buffName}`);
                console.log(`      Server response: ${serverResponse}`);
                return { success: true, buff: buffName };
            })
            .catch(err => {
                console.error(`   ❌ Failed to apply ${buffName}:`, err.message);
                if (err.response?.data?.data?.rawResult) {
                    console.error(`      Server response: ${err.response.data.data.rawResult}`);
                }
                return { success: false, buff: buffName };
            })
    );

    const results = await Promise.all(buffCommands);
    const successCount = results.filter(r => r && r.success).length;

    console.log(`✅ Applied ${successCount}/${buffNames.length} buffs successfully`);

    if (successCount === 0) {
        throw new TakaroUserError(`Failed to apply ${pkg.displayName}. No currency was charged.`);
    }

    if (shouldChargeCurrency) {
        try {
            const cost = Number(pkg.currencyCost);
            await takaro.playerOnGameserver.playerOnGameServerControllerDeductCurrency(gameServerId, pog.playerId, {
                currency: cost
            });
            console.log(`💰 Deducted ${cost} currency`);
        } catch (err) {
            console.error('❌ Currency deduction failed:', err.message);
            throw new TakaroUserError('Buff applied, but currency deduction failed. Please contact an admin.');
        }
    }

    // Set or update expiration variable if duration is set
    if (Number(pkg.duration) > 0) {
        const expiryKey = `buff_expiry_${pkg.commandName}`;
        const expiryTime = Date.now() + (Number(pkg.duration) * 60000);

        try {
            // Check if variable already exists
            const existingVars = await takaro.variable.variableControllerSearch({
                filters: {
                    key: [expiryKey],
                    playerId: [player.id],
                    gameServerId: [gameServerId],
                    moduleId: [module.moduleId]
                }
            });

            if (existingVars.data.data.length > 0) {
                // Update existing variable
                await takaro.variable.variableControllerUpdate(existingVars.data.data[0].id, {
                    value: expiryTime.toString()
                });
                const minutes = Math.floor(Number(pkg.duration));
                const hours = Math.floor(minutes / 60);
                if (hours > 0) {
                    console.log(`⏰ Expiration updated: ${hours}h ${minutes % 60}m`);
                } else {
                    console.log(`⏰ Expiration updated: ${minutes}m`);
                }
            } else {
                // Create new variable
                await takaro.variable.variableControllerCreate({
                    key: expiryKey,
                    value: expiryTime.toString(),
                    playerId: player.id,
                    gameServerId: gameServerId,
                    moduleId: module.moduleId
                });
                const minutes = Math.floor(Number(pkg.duration));
                const hours = Math.floor(minutes / 60);
                if (hours > 0) {
                    console.log(`⏰ Expiration set: ${hours}h ${minutes % 60}m`);
                } else {
                    console.log(`⏰ Expiration set: ${minutes}m`);
                }
            }
        } catch (err) {
            console.error(`⚠️ Failed to set expiration variable:`, err.message);
            // Don't throw - buff was applied successfully
        }
    } else {
        console.log(`⏰ No expiration (permanent buff)`);
    }

    // Send confirmation with properly formatted duration
    let expiryMsg = '';
    if (Number(pkg.duration) > 0) {
        const minutes = Math.floor(Number(pkg.duration));
        const hours = Math.floor(minutes / 60);
        if (hours > 0) {
            expiryMsg = ` (expires in ${hours}h ${minutes % 60}m)`;
        } else {
            expiryMsg = ` (expires in ${minutes}m)`;
        }
    }

    await pog.pm(`${pkg.displayName} applied!${expiryMsg}`);
    console.log('✅ Command complete');
}

await main();