// ストレージアダプタ
// - Claude アーティファクト内: window.storage(永続ストレージAPI)
// - 通常のブラウザ / ローカル / 本番: localStorage にフォールバック
const hasClaudeStorage = () =>
  typeof window !== "undefined" && !!window.storage?.get;

export const storage = {
  async get(key) {
    if (hasClaudeStorage()) {
      try {
        return await window.storage.get(key);
      } catch {
        return null; // キー未作成
      }
    }
    const value = localStorage.getItem(key);
    return value == null ? null : { key, value };
  },

  async set(key, value) {
    if (hasClaudeStorage()) {
      return window.storage.set(key, value);
    }
    localStorage.setItem(key, value);
    return { key, value };
  },
};
