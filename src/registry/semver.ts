/** Strict `x.y.z` only: no pre-release, no build metadata, no leading zeros. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isStrictSemver(value: string): boolean {
  return STRICT_SEMVER.test(value);
}

function parts(version: string): number[] {
  return version.split('.').map(Number);
}

export function compareSemver(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function maxSemver(versions: string[]): string {
  return versions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max));
}
