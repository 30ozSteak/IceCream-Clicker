export const PACK_CATALOG_VERSION = 2;
export const STARTER_PACKS_BEFORE_UNLOCK = 3;

export type ReloadMechanicId =
  | "precision"
  | "countdown"
  | "chip-hop"
  | "hands-off"
  | "sprinkle-rush"
  | "converge"
  | "spiral-hold"
  | "triple-snap"
  | "pop-launch";

export interface ReloadWindow {
  startMs: number;
  endMs: number;
}

interface BasePackReloadDefinition {
  label: string;
  instruction: string;
  durationMs: number;
  windows: readonly ReloadWindow[];
}

type SimpleReloadMechanicId = Exclude<
  ReloadMechanicId,
  "spiral-hold" | "triple-snap" | "pop-launch"
>;

export interface SimplePackReloadDefinition extends BasePackReloadDefinition {
  id: SimpleReloadMechanicId;
}

export interface SpiralHoldReloadDefinition extends BasePackReloadDefinition {
  id: "spiral-hold";
  pressWindow: ReloadWindow;
  minHoldMs: number;
  maxHoldMs: number;
}

export interface TripleSnapReloadDefinition extends BasePackReloadDefinition {
  id: "triple-snap";
  beats: readonly ReloadWindow[];
}

export interface PopLaunchReloadDefinition extends BasePackReloadDefinition {
  id: "pop-launch";
  launchWindow: ReloadWindow;
  minTravelPx: number;
  maxGestureMs: number;
}

export type PackReloadDefinition =
  | SimplePackReloadDefinition
  | SpiralHoldReloadDefinition
  | TripleSnapReloadDefinition
  | PopLaunchReloadDefinition;

export interface PackDefinition {
  id: string;
  name: string;
  shortName: string;
  quantity: number;
  imageSrc: string;
  accent: string;
  accentSoft: string;
  reload: PackReloadDefinition;
}

export const PACK_CATALOG = [
  {
    id: "vanilla-6",
    name: "Premium Vanilla",
    shortName: "Vanilla 6",
    quantity: 6,
    imageSrc: "/brand/fatboy-vanilla-6-pack.webp",
    accent: "#ffd95e",
    accentSoft: "#fff1b4",
    reload: {
      id: "precision",
      label: "Sweet spot",
      instruction:
        "Start the sweep, then click once while the marker crosses the gold stripe.",
      durationMs: 2_400,
      windows: [{ startMs: 1_320, endMs: 1_800 }],
    },
  },
  {
    id: "vanilla-12",
    name: "Premium Vanilla 12-Pack",
    shortName: "Vanilla 12",
    quantity: 12,
    imageSrc: "/brand/fatboy-vanilla-12-pack.webp",
    accent: "#ffd95e",
    accentSoft: "#fff1b4",
    reload: {
      id: "countdown",
      label: "Big-box countdown",
      instruction:
        "Watch the 3–2–1 countdown and click when the timer flips to OPEN.",
      durationMs: 3_400,
      windows: [{ startMs: 2_680, endMs: 3_080 }],
    },
  },
  {
    id: "cookies-cream-6",
    name: "Cookies ’n Cream",
    shortName: "Cookies ’n Cream 6",
    quantity: 6,
    imageSrc: "/brand/fatboy-cookies-cream-6-pack.webp",
    accent: "#9fc9e8",
    accentSoft: "#dcedfa",
    reload: {
      id: "chip-hop",
      label: "Chip hop",
      instruction:
        "The marker bounces across three cookie chips. Click inside any blue chip.",
      durationMs: 2_800,
      windows: [
        { startMs: 520, endMs: 760 },
        { startMs: 1_240, endMs: 1_480 },
        { startMs: 1_960, endMs: 2_200 },
      ],
    },
  },
  {
    id: "caramel-cashew-4",
    name: "Caramel Cashew",
    shortName: "Caramel Cashew 4",
    quantity: 4,
    imageSrc: "/brand/fatboy-caramel-cashew-4-pack.webp",
    accent: "#ff9f4f",
    accentSoft: "#ffd5ae",
    reload: {
      id: "hands-off",
      label: "Slow pour",
      instruction:
        "Start the caramel pour, then hands off—the box opens itself when it settles.",
      durationMs: 3_000,
      windows: [],
    },
  },
  {
    id: "sugar-cookie-6",
    name: "Sugar Cookie",
    shortName: "Sugar Cookie 6",
    quantity: 6,
    imageSrc: "/brand/fatboy-sugar-cookie-6-pack.webp",
    accent: "#f3a1c8",
    accentSoft: "#ffd6e9",
    reload: {
      id: "sprinkle-rush",
      label: "Sprinkle rush",
      instruction:
        "Three sprinkle pulses flash across the meter. Click during any pink pulse.",
      durationMs: 2_700,
      windows: [
        { startMs: 600, endMs: 820 },
        { startMs: 1_250, endMs: 1_470 },
        { startMs: 1_900, endMs: 2_120 },
      ],
    },
  },
  {
    id: "caramel-cookies-cream-4",
    name: "Caramel Cookies ’N Cream",
    shortName: "Caramel C’nC 4",
    quantity: 4,
    imageSrc: "/brand/fatboy-caramel-cookies-cream-4-pack.webp",
    accent: "#8fc5de",
    accentSoft: "#d5eef8",
    reload: {
      id: "converge",
      label: "Cookie pinch",
      instruction:
        "Two markers close in from the edges. Click when they overlap in the center.",
      durationMs: 3_000,
      windows: [{ startMs: 1_420, endMs: 1_820 }],
    },
  },
  {
    id: "cinnamon-churro-4",
    name: "Cinnamon Churro",
    shortName: "Cinnamon Churro 4",
    quantity: 4,
    imageSrc: "/brand/fatboy-cinnamon-churro-4-pack.webp",
    accent: "#d8a15f",
    accentSoft: "#f4d6ad",
    reload: {
      id: "spiral-hold",
      label: "Churro spiral",
      instruction:
        "Press during CATCH, keep holding, then release when the caramel spiral reaches GLAZE.",
      durationMs: 3_600,
      pressWindow: { startMs: 600, endMs: 1_200 },
      minHoldMs: 500,
      maxHoldMs: 1_800,
      windows: [{ startMs: 1_700, endMs: 2_400 }],
    },
  },
  {
    id: "chocolate-6",
    name: "Chocolate",
    shortName: "Chocolate 6",
    quantity: 6,
    imageSrc: "/brand/fatboy-chocolate-6-pack.webp",
    accent: "#c58b72",
    accentSoft: "#e8c1ae",
    reload: {
      id: "triple-snap",
      label: "Triple snap",
      instruction:
        "Tap all three chocolate-bar beats in order. The third snap opens the box early.",
      durationMs: 4_000,
      beats: [
        { startMs: 450, endMs: 1_000 },
        { startMs: 1_450, endMs: 2_000 },
        { startMs: 2_450, endMs: 3_000 },
      ],
      windows: [{ startMs: 2_450, endMs: 3_000 }],
    },
  },
  {
    id: "birthday-cake-pops-4",
    name: "Birthday Cake Sandwich Pops",
    shortName: "Birthday Pops 4",
    quantity: 4,
    imageSrc: "/brand/fatboy-birthday-cake-pops-4-pack.webp",
    accent: "#59c9e8",
    accentSoft: "#f4b9d8",
    reload: {
      id: "pop-launch",
      label: "Pop launch",
      instruction:
        "Press during LAUNCH, then swipe the pop upward through the PARTY ring.",
      durationMs: 3_500,
      launchWindow: { startMs: 700, endMs: 1_300 },
      minTravelPx: 48,
      maxGestureMs: 1_600,
      windows: [{ startMs: 1_700, endMs: 2_300 }],
    },
  },
] as const satisfies readonly PackDefinition[];

export type PackId = (typeof PACK_CATALOG)[number]["id"];

const PACK_BY_ID = new Map<string, PackDefinition>(
  PACK_CATALOG.map((pack) => [pack.id, pack]),
);

const POST_UNLOCK_CYCLE: readonly PackDefinition[] = [
  PACK_CATALOG[1],
  PACK_CATALOG[2],
  PACK_CATALOG[3],
  PACK_CATALOG[4],
  PACK_CATALOG[5],
  PACK_CATALOG[0],
  PACK_CATALOG[6],
  PACK_CATALOG[7],
  PACK_CATALOG[8],
];

export const MAX_PACK_QUANTITY = Math.max(
  ...PACK_CATALOG.map((pack) => pack.quantity),
);

export function getPackById(id: string): PackDefinition | null {
  return PACK_BY_ID.get(id) ?? null;
}

export function getPackForOrdinal(packOrdinal: number): PackDefinition {
  if (!Number.isSafeInteger(packOrdinal) || packOrdinal < 1) {
    throw new RangeError("Pack ordinal must be a positive integer.");
  }

  if (packOrdinal <= STARTER_PACKS_BEFORE_UNLOCK) {
    return PACK_CATALOG[0];
  }

  const cycleIndex =
    (packOrdinal - STARTER_PACKS_BEFORE_UNLOCK - 1) %
    POST_UNLOCK_CYCLE.length;
  return POST_UNLOCK_CYCLE[cycleIndex];
}

export function getPacksCleared(
  packsOpened: number,
  sandwichesRemaining: number,
): number {
  return Math.max(0, packsOpened - (sandwichesRemaining > 0 ? 1 : 0));
}

export function getClearedPackHistory(
  packsCleared: number,
): PackDefinition[] {
  if (!Number.isSafeInteger(packsCleared) || packsCleared < 0) {
    throw new RangeError("Cleared pack count must be a nonnegative integer.");
  }

  return Array.from({ length: packsCleared }, (_, index) =>
    getPackForOrdinal(index + 1),
  );
}

export function getDisplayedClearedPackCount(
  packsCleared: number,
  sandwichesRemaining: number,
): number {
  if (!Number.isSafeInteger(packsCleared) || packsCleared < 0) {
    throw new RangeError("Cleared pack count must be a nonnegative integer.");
  }
  if (!Number.isSafeInteger(sandwichesRemaining) || sandwichesRemaining < 0) {
    throw new RangeError("Remaining sandwich count must be a nonnegative integer.");
  }

  return Math.max(0, packsCleared - (sandwichesRemaining === 0 ? 1 : 0));
}
