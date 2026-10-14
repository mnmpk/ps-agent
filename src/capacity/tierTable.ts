/**
 * Hardcoded Atlas dedicated-tier table: instanceSize → RAM (GB), vCPUs, and
 * default storage IOPS. Used to compute utilization % and scaling factors when
 * the measurements API doesn't report RAM/IOPS limits directly.
 *
 * Values are the published Atlas defaults (AWS baseline). "Low-CPU" (Rxx)
 * variants share RAM/disk with their Mxx sibling but have fewer vCPUs; we map
 * them to the same RAM and halve vCPUs as an approximation. Keep updatable.
 *
 * NOTE: these are approximations for planning, not billing-exact figures.
 */
export interface TierInfo {
  ramGB: number;
  vcpus: number;
  defaultDiskIOPS: number;
}

const TIERS: Record<string, TierInfo> = {
  M10: { ramGB: 2, vcpus: 2, defaultDiskIOPS: 3000 },
  M20: { ramGB: 4, vcpus: 2, defaultDiskIOPS: 3000 },
  M30: { ramGB: 8, vcpus: 2, defaultDiskIOPS: 3000 },
  M40: { ramGB: 16, vcpus: 4, defaultDiskIOPS: 3000 },
  M50: { ramGB: 32, vcpus: 8, defaultDiskIOPS: 3000 },
  M60: { ramGB: 64, vcpus: 16, defaultDiskIOPS: 3000 },
  M80: { ramGB: 128, vcpus: 32, defaultDiskIOPS: 3000 },
  M140: { ramGB: 192, vcpus: 48, defaultDiskIOPS: 3000 },
  M200: { ramGB: 256, vcpus: 64, defaultDiskIOPS: 3000 },
  M300: { ramGB: 384, vcpus: 96, defaultDiskIOPS: 3000 },
  M400: { ramGB: 488, vcpus: 64, defaultDiskIOPS: 3000 },
  M700: { ramGB: 768, vcpus: 96, defaultDiskIOPS: 3000 },
};

/** Ordered list of tiers, smallest → largest, for scale up/down steps. */
export const TIER_ORDER = ["M10", "M20", "M30", "M40", "M50", "M60", "M80", "M140", "M200", "M300", "M400", "M700"];

/** Normalize an instance size like "M40 Low-CPU" or "R40" → base "M40". */
export function normalizeInstanceSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  const s = size.toUpperCase().trim();
  const m = s.match(/^[MR](\d+)/);
  if (!m) return undefined;
  return `M${m[1]}`;
}

/** Look up tier info for an instance size (handles Low-CPU / Rxx). */
export function tierInfo(instanceSize: string | undefined): TierInfo | undefined {
  const base = normalizeInstanceSize(instanceSize);
  if (!base) return undefined;
  const info = TIERS[base];
  if (!info) return undefined;
  // Low-CPU / Rxx: same RAM, roughly half the vCPUs.
  if (instanceSize && /low-cpu|^R/i.test(instanceSize)) {
    return { ...info, vcpus: Math.max(1, Math.round(info.vcpus / 2)) };
  }
  return info;
}

/** The next larger tier (for scale-up), or undefined if already largest. */
export function nextTierUp(instanceSize: string | undefined): string | undefined {
  const base = normalizeInstanceSize(instanceSize);
  if (!base) return undefined;
  const i = TIER_ORDER.indexOf(base);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : undefined;
}

/** The next smaller tier (for scale-down / cost), or undefined if smallest. */
export function nextTierDown(instanceSize: string | undefined): string | undefined {
  const base = normalizeInstanceSize(instanceSize);
  if (!base) return undefined;
  const i = TIER_ORDER.indexOf(base);
  return i > 0 ? TIER_ORDER[i - 1] : undefined;
}
