export function normalizeRoleName(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function getRoleNames(pog) {
  const roles = Array.isArray(pog?.roles) ? pog.roles : [];
  return roles
    .map((role) => role?.name ?? role?.friendlyName ?? role?.role?.name ?? role?.roleName)
    .filter((name) => typeof name === 'string' && name.trim().length > 0);
}

export function normalizeMappings(config) {
  const mappings = Array.isArray(config?.rolePermissionMappings) ? config.rolePermissionMappings : [];
  return mappings
    .map((mapping) => ({
      roleName: String(mapping?.roleName ?? '').trim(),
      permissionLevel: Number(mapping?.permissionLevel),
    }))
    .filter((mapping) => mapping.roleName && Number.isInteger(mapping.permissionLevel));
}

export function selectPermissionForRoles(roleNames, config) {
  const mappings = normalizeMappings(config);
  const normalizedPlayerRoles = new Set(roleNames.map(normalizeRoleName));

  for (const mapping of mappings) {
    if (normalizedPlayerRoles.has(normalizeRoleName(mapping.roleName))) {
      return {
        matched: true,
        matchedRole: mapping.roleName,
        permissionLevel: mapping.permissionLevel,
      };
    }
  }

  if (config?.unmatchedPermissionLevel === null || config?.unmatchedPermissionLevel === undefined || config?.unmatchedPermissionLevel === '') {
    return {
      matched: false,
      matchedRole: '',
      permissionLevel: null,
    };
  }

  const fallbackLevel = Number(config.unmatchedPermissionLevel);
  if (!Number.isInteger(fallbackLevel)) {
    return {
      matched: false,
      matchedRole: '',
      permissionLevel: null,
    };
  }

  return {
    matched: false,
    matchedRole: '',
    permissionLevel: fallbackLevel,
  };
}

export function getPlayerGameId(player, pog) {
  return String(pog?.gameId ?? player?.gameId ?? player?.steamId ?? player?.name ?? player?.id ?? '').trim();
}

export function quoteConsoleValue(value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) {
    throw new Error('Console command placeholder contains a newline; refusing to execute.');
  }
  if (/^[A-Za-z0-9_:\-.]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderTemplate(template, context) {
  return String(template ?? '')
    .replaceAll('{playerGameId}', quoteConsoleValue(context.playerGameId))
    .replaceAll('{playerName}', quoteConsoleValue(context.playerName))
    .replaceAll('{permissionLevel}', String(context.permissionLevel))
    .replaceAll('{matchedRole}', quoteConsoleValue(context.matchedRole || 'unmatched'));
}

export function renderMessage(template, context) {
  return String(template ?? '')
    .replaceAll('{playerGameId}', String(context.playerGameId ?? ''))
    .replaceAll('{playerName}', String(context.playerName ?? ''))
    .replaceAll('{permissionLevel}', String(context.permissionLevel ?? ''))
    .replaceAll('{matchedRole}', String(context.matchedRole || 'unmatched'));
}
