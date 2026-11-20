// The masking rules of privacy-mask: pure functions, no engine calls, so they
// are unit-tested on their own. Every match becomes the same fixed bar, so the
// bar's length never hints at the length of what it hides.

export const BAR = "██████";

/** Turns a text into its masked drawing. */
export type Masker = (text: string) => string;

const MIN_NAME_LENGTH = 2;

// Secrets come first: a key's value may hold an email or digits that a later
// rule would only partly cover.
const SECRET_PREFIX =
  /(?<![\w-])(?:sk_live_|sk_test_|sk-|ghp_|gho_|xox[bap]-|glpat-)[A-Za-z0-9_-]{8,}/g;
const AWS_KEY = /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g;
const GOOGLE_KEY = /(?<![\w-])AIza[0-9A-Za-z_-]{20,}/g;
// Any case; a token of 8 or more characters keeps prose ("bearer of") out.
const BEARER = /(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
// A JWT's header is base64url JSON, so it opens with `eyJ` (`{"`); requiring
// that keeps dotted names such as `example.config.json` out.
const JWT =
  /(?<![\w-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const SECRET_WORD = "(?:key|token|secret|pass|pwd)";
const SECRET_NAME = new RegExp(SECRET_WORD, "i");
// The parts of a name around the secret word are bounded: unbounded, a long
// run such as `keykeykey…` makes the engine retry every split (quadratic).
const NAME_PART = "[\\w.-]{0,64}";
const QUOTED_NAME_PART = '[^"\\n]{0,64}';
// `"api_key": "value"`: the name stays, the value goes. Escaped quotes inside
// the value (`\\"`) belong to it.
const JSON_SECRET = new RegExp(
  `("${QUOTED_NAME_PART}${SECRET_WORD}${QUOTED_NAME_PART}"\\s*:\\s*")((?:[^"\\\\\\n]|\\\\.)+)(")`,
  "gi",
);
// `API_KEY=value`, `password = 'two words'`, `?token=abc&x=1`. `==` is a
// comparison in code, not an assignment, so it is left alone.
const ASSIGNED_SECRET = new RegExp(
  `((?<![\\w.-])${NAME_PART}${SECRET_WORD}${NAME_PART}\\s*=\\s*)(?!=)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'\`&]+))`,
  "gi",
);
// YAML-style `api_key: value`, only at the start of a line (indent or a list
// dash allowed), so prose such as "Key: the plan" mid-sentence is left.
const YAML_SECRET = new RegExp(
  `^([ \\t]*(?:-[ \\t]+)?${NAME_PART}${SECRET_WORD}${NAME_PART}[ \\t]*:[ \\t]+)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s#][^\\n#]*?))(?=[ \\t]*(?:#|$))`,
  "gim",
);

const EMAIL =
  /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

// Greedy on purpose: the callback trims back to the longest part that passes
// the mod-97 check, so a word written after an IBAN does not hide it.
const IBAN_CANDIDATE =
  /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/g;
const IBAN_MIN_LENGTH = 15;

// Postcode plus house number; a postcode alone is not personal enough to hide.
// Letters in any case when written against the digits (`1234ab 12`); with a
// space between, capitals only, so prose such as `in 2024 is 12` is left.
const POSTCODE_NUMBER =
  /(?<![\w])[1-9]\d{3}(?:[A-Za-z]{2}| [A-Z]{2})\s+\d{1,5}(?:[ -]?[A-Za-z](?![A-Za-z])|-\d{1,4})?(?![\w])/g;

// Nine digits, with spaces or dots between groups; checked with the 11-check.
const BSN_CANDIDATE = /(?<![\d.,])\d(?:[ .]?\d){8}(?![ .,]?\d)/g;

// `+31 6 …` and the `0031 6 …` dialling form.
const PHONE_INTERNATIONAL =
  /(?<![\w+])(?:\+|00)\d{1,3}(?:[ .-]?\(?\d\)?){7,13}(?![\d])/g;
// `06-12345678`, `020 123 4567` and `(020) 123 4567`.
const PHONE_DUTCH = /(?<![\w+.,(])\(?0(?:[ .-]?\)?[ .-]?\d){9}(?![\d])/g;
const MIN_PHONE_DIGITS = 9;

const AMOUNT = "\\d(?:[\\d.,]*\\d)?(?:,-)?";
const MONEY_BEFORE = new RegExp(
  `(?:[€$£]|(?<![A-Za-z])(?:EUR|USD)(?![A-Za-z]))\\s?-?${AMOUNT}`,
  "g",
);
const MONEY_AFTER = new RegExp(
  `(?<![\\w.,])${AMOUNT}\\s?(?:€|(?:EUR|USD)(?![A-Za-z]))`,
  "g",
);

const digitsOf = (text: string): string => text.replace(/\D/g, "");

/** The Dutch 11-check: 9a + 8b + ... + 2h - 1i is a multiple of 11. */
export const isValidBsn = (text: string): boolean => {
  const digits = digitsOf(text);

  if (digits.length !== 9 || /^0+$/.test(digits)) {
    return false;
  }

  let sum = 0;

  for (let i = 0; i < 8; i++) {
    sum += Number(digits[i]) * (9 - i);
  }
  sum -= Number(digits[8]);

  return sum % 11 === 0;
};

/** The IBAN mod-97 check, on the text with spaces taken out. */
export const isValidIban = (text: string): boolean => {
  const compact = text.replace(/ /g, "").toUpperCase();

  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) {
    return false;
  }

  const moved = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;

  // Digit by digit, so the number never outgrows a float.
  for (const char of moved) {
    const value = char >= "A" ? String(char.charCodeAt(0) - 55) : char;

    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1;
};

/** The longest start of an IBAN candidate that passes mod-97, or undefined. */
const validIbanPrefix = (candidate: string): string | undefined => {
  for (let end = candidate.length; end >= IBAN_MIN_LENGTH; end--) {
    const isAtBoundary = end === candidate.length || candidate[end] === " ";
    const prefix = candidate.slice(0, end);

    if (isAtBoundary && isValidIban(prefix)) {
      return prefix;
    }
  }

  return undefined;
};

const maskIbans = (text: string): string =>
  text.replace(IBAN_CANDIDATE, (candidate) => {
    const iban = validIbanPrefix(candidate);

    return iban === undefined ? candidate : BAR + candidate.slice(iban.length);
  });

const maskPhones = (text: string): string => {
  const keepShort = (match: string): string =>
    digitsOf(match).length >= MIN_PHONE_DIGITS ? BAR : match;

  return text
    .replace(PHONE_INTERNATIONAL, keepShort)
    .replace(PHONE_DUTCH, keepShort);
};

/** Rebuilds `name = value` (or `name: value`) with the value masked; empty values stay. */
const maskAssigned = (
  match: string,
  head: string,
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  bare: string | undefined,
): string => {
  if (doubleQuoted !== undefined) {
    return doubleQuoted === "" ? match : `${head}"${BAR}"`;
  }
  if (singleQuoted !== undefined) {
    return singleQuoted === "" ? match : `${head}'${BAR}'`;
  }

  return bare === undefined || bare === "" ? match : `${head}${BAR}`;
};

const maskSecrets = (text: string): string =>
  text
    .replace(
      JSON_SECRET,
      (_match, head: string, _value: string, tail: string) =>
        `${head}${BAR}${tail}`,
    )
    .replace(YAML_SECRET, maskAssigned)
    .replace(ASSIGNED_SECRET, maskAssigned)
    .replace(SECRET_PREFIX, BAR)
    .replace(AWS_KEY, BAR)
    .replace(GOOGLE_KEY, BAR)
    .replace(BEARER, (_match, head: string) => `${head}${BAR}`)
    .replace(JWT, BAR);

/** Whether a field name says its value is a secret (`password`, `api_key`). */
export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The listed names, cleaned: trimmed, empty and one-character names dropped,
 * duplicates removed, longest first so `Jan de Vries` wins over `Jan`.
 */
export const cleanNames = (names: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of names) {
    if (typeof name !== "string") {
      continue;
    }

    const trimmed = name.trim().replace(/\s+/g, " ");
    const folded = trimmed.toLowerCase();

    if (trimmed.length >= MIN_NAME_LENGTH && !seen.has(folded)) {
      seen.add(folded);
      result.push(trimmed);
    }
  }

  return result.sort((a, b) => b.length - a.length);
};

/** One regex for all listed names, whole word, any case; null when none. */
const namesPattern = (names: readonly string[]): RegExp | null => {
  if (names.length === 0) {
    return null;
  }

  const alternatives = names.map((name) =>
    name.split(" ").map(escapeRegExp).join("\\s+"),
  );

  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
};

/**
 * Builds the masker for a names list: every regex is compiled here, once, so
 * drawing a row only runs them.
 */
export const createMasker = (names: readonly unknown[]): Masker => {
  const namesRegExp = namesPattern(cleanNames(names));

  return (text: string): string => {
    if (text === "") {
      return text;
    }

    let masked = maskSecrets(text);
    masked = masked.replace(EMAIL, BAR);
    masked = maskIbans(masked);
    masked = masked.replace(POSTCODE_NUMBER, BAR);
    // Phones before BSNs: the last nine digits of a phone number can pass the
    // 11-check by chance, which would leave its country code showing.
    masked = maskPhones(masked);
    masked = masked.replace(BSN_CANDIDATE, (match) =>
      isValidBsn(match) ? BAR : match,
    );
    masked = masked.replace(MONEY_BEFORE, BAR).replace(MONEY_AFTER, BAR);

    if (namesRegExp !== null) {
      masked = masked.replace(namesRegExp, BAR);
    }

    return masked;
  };
};

/** Masks one text with a names list; builds the regexes on each call. */
export const mask = (text: string, names: readonly string[]): string =>
  createMasker(names)(text);
