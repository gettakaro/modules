export function toPositiveInteger(value: unknown, fallback: number | null): number | null;
export function extractCurrentDay(rawOutput: unknown): number | null;
export function calculateNextHordeDay(currentDay: unknown, interval: unknown, firstHordeDay: unknown): number;
export function renderBloodMoonMessage(template: unknown, values: Record<string, unknown>): string;
export function buildDaysUntilText(config: Record<string, unknown>, daysUntil: number): string;
export function resolveCurrentDay(
  gameServerId: string,
  config: Record<string, unknown>,
  takaro: unknown,
): Promise<{ currentDay: number; source: string } | null>;
export function buildBloodMoonResponse(
  gameServerId: string,
  config: Record<string, unknown>,
  takaro: unknown,
): Promise<{ message: string; currentDay: number; nextHordeDay: number; daysUntil: number; source: string } | null>;
