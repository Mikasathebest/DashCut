// Minimal i18n: Chinese source strings are the keys; English dictionaries map them per area.
// Untranslated strings fall back to the Chinese source, so missing entries never break the UI.
import editing from "./en/editing.ts";
import page from "./en/page.ts";
import panels from "./en/panels.ts";

export type Language = "zh" | "en";

const english: Record<string, string> = { ...page, ...editing, ...panels };
let current: Language = "zh";

export function setLanguage(language: Language) {
  current = language;
}

export function getLanguage() {
  return current;
}

/** Translates a Chinese source string; `{name}` placeholders are filled from `values`. */
export function t(source: string, values?: Record<string, string | number>) {
  const text = current === "en" ? english[source] ?? source : source;
  return values ? text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match) : text;
}

export const languageStorageKey = "dashcut.language";

/** Saved choice, else the system language (Chinese locales stay Chinese, everything else English). */
export function preferredLanguage(): Language {
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (saved === "zh" || saved === "en") return saved;
  } catch { /* storage unavailable */ }
  return typeof navigator !== "undefined" && !navigator.language.toLowerCase().startsWith("zh") ? "en" : "zh";
}
