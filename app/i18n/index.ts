// Minimal i18n: Chinese source strings are the keys; English dictionaries map them per area.
// Untranslated strings fall back to the Chinese source, so missing entries never break the UI.
import editing from "./en/editing.ts";
import workspace from "./en/workspace.ts";
import panels from "./en/panels.ts";

export type Language = "zh" | "en";

const english: Record<string, string> = { ...workspace, ...editing, ...panels };
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

/** The saved choice; DashCut is Chinese-first, so the interface starts in Chinese until switched. */
export function preferredLanguage(): Language {
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (saved === "zh" || saved === "en") return saved;
  } catch { /* storage unavailable */ }
  return "zh";
}
