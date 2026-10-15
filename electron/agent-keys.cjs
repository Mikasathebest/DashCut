/* eslint-disable @typescript-eslint/no-require-imports */
// API key storage for the editing agent. Keys are encrypted with Electron safeStorage
// (OS keychain-backed) before touching disk; without encryption they live in memory only.
const fs = require("node:fs");
const path = require("node:path");

const KINDS = new Set(["openai", "anthropic", "captions"]);

function checkKind(kind) {
  if (!KINDS.has(kind)) throw new Error("不支持的模型提供方");
}

function createKeyStore({ file, safeStorage }) {
  const memory = new Map();
  const encryptionAvailable = () => {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()); } catch { return false; }
  };

  function readFile() {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  }

  function writeFile(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    try { fs.renameSync(temp, file); }
    catch (error) { try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ } throw error; }
  }

  return {
    persistent: encryptionAvailable,
    set(kind, key) {
      checkKind(kind);
      const value = typeof key === "string" ? key.trim() : "";
      if (!value || /[\r\n]/.test(value)) throw new Error("API Key 无效");
      memory.set(kind, value);
      if (!encryptionAvailable()) return { persisted: false };
      const data = readFile();
      data[kind] = Buffer.from(safeStorage.encryptString(value)).toString("base64");
      writeFile(data);
      return { persisted: true };
    },
    get(kind) {
      checkKind(kind);
      if (memory.has(kind)) return memory.get(kind);
      if (!encryptionAvailable()) return null;
      const stored = readFile()[kind];
      if (typeof stored !== "string") return null;
      try {
        const value = safeStorage.decryptString(Buffer.from(stored, "base64"));
        memory.set(kind, value);
        return value;
      } catch { return null; }
    },
    has(kind) {
      checkKind(kind);
      if (memory.has(kind)) return true;
      return encryptionAvailable() && typeof readFile()[kind] === "string";
    },
    clear(kind) {
      checkKind(kind);
      memory.delete(kind);
      const data = readFile();
      if (kind in data) { delete data[kind]; writeFile(data); }
    },
  };
}

module.exports = { createKeyStore };
