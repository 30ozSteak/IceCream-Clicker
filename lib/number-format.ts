const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx"] as const;

/** 950 → "950", 1234 → "1.23K", 45_600_000 → "45.6M". */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  const whole = Math.floor(value);
  if (whole < 1_000) {
    return String(whole);
  }

  let tier = Math.min(
    SUFFIXES.length - 1,
    Math.floor(Math.log10(whole) / 3),
  );
  let scaled = whole / 1_000 ** tier;
  // Truncate rather than round so a price never displays as affordable early.
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const factor = 10 ** digits;
  scaled = Math.floor(scaled * factor + 1e-9) / factor;
  if (scaled >= 1_000 && tier < SUFFIXES.length - 1) {
    tier += 1;
    scaled = 1;
  }
  return `${scaled.toFixed(digits).replace(/\.?0+$/, "")}${SUFFIXES[tier]}`;
}

/** Per-second rates keep one decimal while they are small. */
export function formatRate(value: number): string {
  if (value > 0 && value < 100) {
    return (Math.floor(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  }
  return formatAmount(value);
}
