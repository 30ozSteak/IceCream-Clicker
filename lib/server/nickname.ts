export type NicknameValidation =
  | { ok: true; nickname: string }
  | { ok: false; reason: "type" | "length" | "characters" | "blocked" };

const RESERVED_WORDS = new Set([
  "admin",
  "administrator",
  "mod",
  "moderator",
  "official",
  "staff",
  "support",
  "system",
  "team",
]);

const BLOCKED_WORDS = new Set([
  "bitch",
  "bullshit",
  "cunt",
  "dick",
  "faggot",
  "fuck",
  "fucker",
  "fucking",
  "fuckyou",
  "nigger",
  "pussy",
  "shit",
  "shithead",
  "slut",
]);

const CONFUSABLES: Readonly<Record<string, string>> = {
  // Common Cyrillic and Greek homoglyphs used to disguise reserved names and
  // blocked words. The nickname itself remains Unicode; only the private
  // comparison key is folded.
  а: "a",
  α: "a",
  в: "b",
  е: "e",
  ε: "e",
  і: "i",
  ι: "i",
  к: "k",
  κ: "k",
  м: "m",
  μ: "m",
  н: "h",
  о: "o",
  ο: "o",
  р: "p",
  ρ: "p",
  с: "c",
  т: "t",
  τ: "t",
  у: "y",
  υ: "y",
  х: "x",
  χ: "x",
};

function canonicalWord(value: string): string {
  const folded = value
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replaceAll("0", "o")
    .replaceAll("1", "i")
    .replaceAll("3", "e")
    .replaceAll("4", "a")
    .replaceAll("5", "s")
    .replaceAll("7", "t");

  return Array.from(folded, (character) => CONFUSABLES[character] ?? character).join(
    "",
  );
}

export function validateNickname(value: unknown): NicknameValidation {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }

  const nickname = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const characterCount = Array.from(nickname).length;
  if (characterCount < 2 || characterCount > 16) {
    return { ok: false, reason: "length" };
  }

  if (!/^[\p{L}\p{N} ]+$/u.test(nickname)) {
    return { ok: false, reason: "characters" };
  }

  const words = nickname.split(" ").map(canonicalWord);
  const joined = words.join("");
  const isReserved = words.some(
    (word) =>
      RESERVED_WORDS.has(word) ||
      word.startsWith("admin") ||
      word.startsWith("moderator"),
  );
  const isProfane = Array.from(BLOCKED_WORDS).some(
    (blockedWord) => joined.includes(blockedWord),
  );

  if (isReserved || isProfane) {
    return { ok: false, reason: "blocked" };
  }

  return { ok: true, nickname };
}
