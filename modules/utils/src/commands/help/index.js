import { data, takaro, TakaroUserError } from '@takaro/helpers';

// Each command's permissions belong to its own Module, so they are matched against that Module's id.
function holdsModulePermission(pog, code, moduleId) {
  return pog.roles.some(({ role }) =>
    role.permissions.some(
      ({ permission }) =>
        (permission.permission === 'ROOT' && !permission.module) ||
        (permission.permission === code && permission.module?.id === moduleId),
    ),
  );
}

function canUse(command) {
  return (
    !command.requiredPermissions ||
    command.requiredPermissions.length === 0 ||
    command.requiredPermissions.every((permission) => holdsModulePermission(data.pog, permission, command.moduleId))
  );
}

// oxlint-disable-next-line sonarjs/cognitive-complexity -- GH #4103
async function main() {
  const enabledModules = await takaro.module.moduleInstallationsControllerGetInstalledModules({
    filters: { gameserverId: [data.gameServerId] },
  });

  const moduleCommands = await Promise.all(
    enabledModules.data.data.map(async (mod) => {
      // Check if the module itself is enabled
      if (!mod.systemConfig.enabled) {
        return [];
      }

      const installedVersion = await takaro.module.moduleVersionControllerGetModuleVersion(mod.versionId);
      const commands = installedVersion.data.data.commands;

      // Filter out disabled commands
      return commands
        .filter((command) => {
          const commandConfig = mod.systemConfig.commands && mod.systemConfig.commands[command.name];
          return commandConfig && commandConfig.enabled;
        })
        .map((command) => ({ ...command, moduleId: mod.moduleId }));
    }),
  );
  const allCommandsFlat = moduleCommands.flat();

  const accessibleCommands = allCommandsFlat.filter(canUse);

  if (data.arguments.command === 'search') {
    // Check if a search term was actually provided (not the default 'none')
    if (data.arguments.searchTerm === 'none') {
      throw new TakaroUserError('Please provide a search term. Usage: /help search <term>');
    }

    // Search functionality
    const searchTerm = data.arguments.searchTerm.toLowerCase();
    const matchingCommands = accessibleCommands.filter((command) => {
      // Check if command name contains search term
      const nameMatch = command.name.toLowerCase().includes(searchTerm);
      // Check if help text contains search term
      const helpTextMatch = command.helpText.toLowerCase().includes(searchTerm);
      return nameMatch || helpTextMatch;
    });

    if (matchingCommands.length === 0) {
      await data.player.pm(`No commands found matching "${data.arguments.searchTerm}".`);
    } else {
      await data.player.pm(`Commands matching "${data.arguments.searchTerm}":`);
      await Promise.all(
        matchingCommands.map(async (command) => {
          await data.player.pm(`${command.name}: ${command.helpText}`);
        }),
      );
    }
  } else if (data.arguments.command === 'all') {
    await data.player.pm('Available commands:');

    if (accessibleCommands.length === 0) {
      await data.player.pm('No commands available to you.');
    } else {
      await Promise.all(
        accessibleCommands.map(async (command) => {
          await data.player.pm(`${command.name}: ${command.helpText}`);
        }),
      );
    }
  } else {
    const requestedCommand = allCommandsFlat.find((c) => {
      return c.name === data.arguments.command;
    });

    if (requestedCommand) {
      if (!canUse(requestedCommand)) {
        throw new TakaroUserError(`You don't have permission to use the "${data.arguments.command}" command.`);
      }

      await data.player.pm(`${requestedCommand.name}: ${requestedCommand.helpText}`);
    } else {
      throw new TakaroUserError(
        `Unknown command "${data.arguments.command}", use this command without arguments to see all available commands.`,
      );
    }
  }
}

await main();
