// tools/web/boot.ts — the small, host-owned URL bridge used by the web
// player. Values stay as URL strings; each game owns their semantic and
// numeric validation.

export const RPGKIT_BOOT_KEYS = ["chapter", "map", "x", "y", "autoplay", "speed"] as const;

export type RpgkitBoot = Partial<Record<(typeof RPGKIT_BOOT_KEYS)[number], string>>;

/** Copy only the supported deep-link keys, preserving empty string values. */
export function rpgkitBootFromSearch(search: string): RpgkitBoot {
  const query = new URLSearchParams(search);
  const boot: RpgkitBoot = {};
  for (const key of RPGKIT_BOOT_KEYS) {
    if (query.has(key)) boot[key] = query.get(key) ?? "";
  }
  return boot;
}
