// GitHub Gist を使った端末間同期
// データは利用者自身の GitHub アカウントに非公開 Gist として保存される。
// 競合解決はドキュメント単位の Last-Write-Wins(updatedAt が新しい方を採用)。
const API = "https://api.github.com";
const FILE = "subscription-manager-data.json";
const CONFIG_KEY = "subman:sync";

// gist スコープだけを付けたトークン作成ページ(スコープ・名前はプリセット済み)
export const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=gist&description=subscription-manager-sync";

// ---- 設定の保存(この端末のみ・localStorage)----

export function loadSyncConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY));
    return cfg && typeof cfg.token === "string" && typeof cfg.gistId === "string" ? cfg : null;
  } catch {
    return null;
  }
}

export function saveSyncConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function clearSyncConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

// ---- 端末追加リンク(#sync=<base64url {t,g}>)----

const toB64url = (s) =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) =>
  decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export const toSyncHash = (cfg) =>
  "#sync=" + toB64url(JSON.stringify({ t: cfg.token, g: cfg.gistId }));

export function parseSyncHash(hash) {
  const m = (hash || "").match(/^#sync=([A-Za-z0-9\-_]+)$/);
  if (!m) return null;
  try {
    const p = JSON.parse(fromB64url(m[1]));
    return typeof p.t === "string" && typeof p.g === "string"
      ? { token: p.t, gistId: p.g }
      : null;
  } catch {
    return null;
  }
}

// ---- GitHub API ----

const headers = (token) => ({
  Authorization: "Bearer " + token,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

async function req(url, opts) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  if (!res.ok) {
    const err = new Error("GitHub API error: " + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 既存の同期用 Gist を探す(別端末で作成済みならそれを再利用)
export async function findRemote(token) {
  const gists = await req(`${API}/gists?per_page=100`, { headers: headers(token) });
  const hit = gists.find((g) => g.files && g.files[FILE]);
  return hit ? hit.id : null;
}

export async function createRemote(token, data) {
  const json = await req(`${API}/gists`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      description: "サブスク管理アプリ 同期データ",
      public: false,
      files: { [FILE]: { content: JSON.stringify(data) } },
    }),
  });
  return json.id;
}

export async function pullRemote(cfg) {
  const json = await req(`${API}/gists/${cfg.gistId}`, { headers: headers(cfg.token) });
  const file = json.files && json.files[FILE];
  if (!file) return null;
  let content = file.content;
  if (file.truncated) {
    const res = await fetch(file.raw_url, { cache: "no-store" });
    if (!res.ok) throw new Error("raw fetch failed: " + res.status);
    content = await res.text();
  }
  const data = JSON.parse(content);
  return {
    subs: Array.isArray(data.subs) ? data.subs : [],
    checked: Array.isArray(data.checked) ? data.checked : [],
    updatedAt: Number(data.updatedAt) || 0,
  };
}

export async function pushRemote(cfg, data) {
  await req(`${API}/gists/${cfg.gistId}`, {
    method: "PATCH",
    headers: headers(cfg.token),
    body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } }),
  });
}
