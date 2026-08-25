export const FEED_REACTIONS = [
  "Wow!",
  "Yum!",
  "Delicious!",
  "Another!",
] as const;

export function getFeedReaction(sandwichesFed: number) {
  const completedFeeds = Number.isFinite(sandwichesFed)
    ? Math.max(1, Math.trunc(sandwichesFed))
    : 1;

  return FEED_REACTIONS[(completedFeeds - 1) % FEED_REACTIONS.length];
}
