import { useState, useEffect, useRef } from "react";
import { storage } from "./storage.js";
import {
  TOKEN_URL, loadSyncConfig, saveSyncConfig, clearSyncConfig,
  toSyncHash, parseSyncHash, findRemote, createRemote, pullRemote, pushRemote,
} from "./sync.js";

const STORAGE_KEY = "subman:data";

// 旧データ(cycle なし)は月払いとして扱う
const normalizeSubs = (arr) =>
  (Array.isArray(arr) ? arr : []).map((s) => (s.cycle ? s : { ...s, cycle: "monthly" }));

// ---- 金額カウントアップ ----
function useCountUp(target, dur = 450) {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setVal(target); prev.current = target; return; }
    const from = prev.current;
    prev.current = target;
    if (from === target) return;
    const t0 = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min((t - t0) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setVal(Math.round(from + (target - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return val;
}

const yen = (n) => "¥" + Math.round(Number(n || 0)).toLocaleString("ja-JP");

// 月額換算(年払いは12分割)
const monthlyOf = (s) => (s.cycle === "yearly" ? s.price / 12 : s.price);
const yearlyOf = (s) => (s.cycle === "yearly" ? s.price : s.price * 12);

// 全データを #import= 用の base64url に変換(別端末への共有リンク)
const toImportHash = (subs) =>
  btoa(unescape(encodeURIComponent(JSON.stringify({ subs }))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 今日から次の引き落としまでの日数(31日など存在しない日は月末に丸める)
function daysUntil(s) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const clamp = (y, m) => {
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(s.day, last));
  };
  let next;
  if (s.cycle === "yearly") {
    next = clamp(now.getFullYear(), s.month - 1);
    if (next < today) next = clamp(now.getFullYear() + 1, s.month - 1);
  } else {
    next = clamp(now.getFullYear(), now.getMonth());
    if (next < today) next = clamp(now.getFullYear(), now.getMonth() + 1);
  }
  return Math.round((next - today) / 86400000);
}

export default function SubscriptionManager() {
  const [subs, setSubs] = useState([]);
  const [checked, setChecked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [showForm, setShowForm] = useState(false);
  const [shareState, setShareState] = useState("idle");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", price: "", day: "", cycle: "monthly", month: "" });
  const [syncCfg, setSyncCfg] = useState(null);
  const [syncState, setSyncState] = useState("off"); // off | syncing | ok | error
  const [showSync, setShowSync] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [deviceLinkState, setDeviceLinkState] = useState("idle");
  const loaded = useRef(false);
  const initStarted = useRef(false);
  const saveTimer = useRef(null);
  const syncCfgRef = useRef(null);
  const updatedAtRef = useRef(0); // データの最終更新時刻(LWW の比較キー)
  const changeSrcRef = useRef("idle"); // "user" のときだけリモートへ push(同期ループ防止)
  const lastPullAtRef = useRef(0);
  syncCfgRef.current = syncCfg;

  // pull → 新しい方を採用 → ローカルが新しければ push(双方向の突き合わせ)
  const reconcile = async (localOverride, cfgOverride) => {
    const cfg = cfgOverride || syncCfgRef.current;
    if (!cfg) return;
    lastPullAtRef.current = Date.now();
    setSyncState("syncing");
    try {
      const remote = await pullRemote(cfg);
      if (remote && remote.updatedAt > updatedAtRef.current) {
        changeSrcRef.current = "remote";
        updatedAtRef.current = remote.updatedAt;
        setSubs(normalizeSubs(remote.subs));
        setChecked(remote.checked);
      } else if (!remote || remote.updatedAt < updatedAtRef.current) {
        const local = localOverride || { subs, checked };
        await pushRemote(cfg, { ...local, updatedAt: updatedAtRef.current });
      }
      setSyncState("ok");
    } catch (e) {
      setSyncState("error");
    }
  };
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  // ---- 読み込み ----
  useEffect(() => {
    // StrictMode の二重実行ガード(ハッシュ消費が1回きりのため必須)
    if (initStarted.current) return;
    initStarted.current = true;
    (async () => {
      let subs0 = [];
      let checked0 = [];
      let updatedAt0 = 0;
      // ---- 同期への参加(#sync=<base64url {t,g}>)----
      // PC で発行した「別の端末を追加」リンクをスマホで開くと、この端末も同期に加わる
      let cfg = parseSyncHash(window.location.hash);
      if (cfg) {
        saveSyncConfig(cfg);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        cfg = loadSyncConfig();
      }
      try {
        const result = await storage.get(STORAGE_KEY);
        if (result && result.value) {
          const data = JSON.parse(result.value);
          subs0 = normalizeSubs(data.subs);
          checked0 = Array.isArray(data.checked) ? data.checked : [];
          updatedAt0 = Number(data.updatedAt) || 0;
        }
      } catch (e) {
        // 初回起動(キー未作成)は空でOK
      }
      // ---- URL からの取り込み(#import=<base64url JSON>)----
      // 同じ id は上書き更新、新しい id は追加(重複はしない)
      try {
        const m = window.location.hash.match(/^#import=([A-Za-z0-9\-_]+)$/);
        if (m) {
          const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
          const payload = JSON.parse(json);
          const incoming = (Array.isArray(payload.subs) ? payload.subs : []).filter(
            (s) =>
              s && typeof s.id === "string" &&
              typeof s.name === "string" && s.name.trim() &&
              Number.isFinite(s.price) && s.price >= 0 &&
              Number.isInteger(s.day) && s.day >= 1 && s.day <= 31 &&
              (s.cycle === "monthly" ||
                (s.cycle === "yearly" && Number.isInteger(s.month) && s.month >= 1 && s.month <= 12))
          );
          const existing = new Set(subs0.map((s) => s.id));
          const byId = new Map(subs0.map((s) => [s.id, s]));
          for (const s of incoming) byId.set(s.id, s);
          subs0 = [...byId.values()];
          checked0 = [...checked0, ...incoming.filter((s) => !existing.has(s.id)).map((s) => s.id)];
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          if (incoming.length) {
            changeSrcRef.current = "user"; // 取り込んだ内容は同期先にも push する
            updatedAt0 = Date.now();
          }
        }
      } catch (e) {
        // 壊れたインポートデータは無視
      }
      updatedAtRef.current = updatedAt0;
      setSubs(subs0);
      setChecked(checked0);
      loaded.current = true;
      setLoading(false);
      // リモートとの突き合わせは画面表示後にバックグラウンドで行う
      if (cfg) {
        setSyncCfg(cfg);
        reconcileRef.current({ subs: subs0, checked: checked0 }, cfg);
      }
    })();
  }, []);

  // ---- 定期的な取り込み(タブ復帰時+60秒ごと)----
  useEffect(() => {
    if (!syncCfg) return;
    const kick = () => {
      if (document.hidden) return;
      if (Date.now() - lastPullAtRef.current < 10000) return;
      reconcileRef.current();
    };
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", kick);
    const iv = setInterval(kick, 60000);
    return () => {
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", kick);
      clearInterval(iv);
    };
  }, [syncCfg]);

  // ---- 自動保存(ユーザー操作なら同期先にも push)----
  useEffect(() => {
    if (!loaded.current) return;
    const fromUser = changeSrcRef.current === "user";
    changeSrcRef.current = "idle";
    if (fromUser) updatedAtRef.current = Date.now();
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await storage.set(STORAGE_KEY, JSON.stringify({ subs, checked, updatedAt: updatedAtRef.current }));
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1600);
      } catch (e) {
        setSaveState("error");
      }
      if (fromUser && syncCfgRef.current) {
        setSyncState("syncing");
        try {
          await pushRemote(syncCfgRef.current, { subs, checked, updatedAt: updatedAtRef.current });
          setSyncState("ok");
        } catch (e) {
          setSyncState("error");
        }
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [subs, checked]);

  // ---- 操作 ----
  const markUser = () => { changeSrcRef.current = "user"; };
  const openAdd = () => { setEditingId(null); setForm({ name: "", price: "", day: "", cycle: "monthly", month: "" }); setShowForm(true); };
  const openEdit = (s) => {
    setEditingId(s.id);
    setForm({ name: s.name, price: String(s.price), day: String(s.day), cycle: s.cycle, month: s.cycle === "yearly" ? String(s.month) : "" });
    setShowForm(true);
  };
  const submit = () => {
    const name = form.name.trim();
    const price = parseInt(form.price, 10);
    const day = parseInt(form.day, 10);
    const month = parseInt(form.month, 10);
    if (!name || isNaN(price) || price < 0 || isNaN(day) || day < 1 || day > 31) return;
    if (form.cycle === "yearly" && (isNaN(month) || month < 1 || month > 12)) return;
    const entry = { name, price, day, cycle: form.cycle, ...(form.cycle === "yearly" ? { month } : {}) };
    markUser();
    if (editingId) {
      setSubs((p) => p.map((s) => (s.id === editingId ? { id: s.id, ...entry } : s)));
    } else {
      const id = crypto.randomUUID();
      setSubs((p) => [...p, { id, ...entry }]);
      setChecked((p) => [...p, id]); // 追加時はデフォルトで合計に含める
    }
    setShowForm(false);
  };
  const remove = (id) => { markUser(); setSubs((p) => p.filter((s) => s.id !== id)); setChecked((p) => p.filter((c) => c !== id)); };
  const toggle = (id) => { markUser(); setChecked((p) => (p.includes(id) ? p.filter((c) => c !== id) : [...p, id])); };
  const toggleAll = () => { markUser(); setChecked((p) => (p.length === subs.length ? [] : subs.map((s) => s.id))); };
  const copyShareLink = async () => {
    const url = window.location.origin + window.location.pathname + "#import=" + toImportHash(subs);
    try {
      await navigator.clipboard.writeText(url);
      setShareState("copied");
    } catch (e) {
      window.prompt("このリンクを別端末で開くと同じデータになります", url);
      setShareState("idle");
      return;
    }
    setTimeout(() => setShareState("idle"), 2000);
  };

  // ---- 同期の開始(1台目・トークンを入力)----
  const startSync = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setSyncBusy(true);
    setSyncError("");
    try {
      let gistId = await findRemote(token); // 別端末で作成済みの Gist があれば再利用
      let cfg;
      if (gistId) {
        cfg = { token, gistId };
        saveSyncConfig(cfg);
        setSyncCfg(cfg);
        await reconcile({ subs, checked }, cfg);
      } else {
        if (!updatedAtRef.current) updatedAtRef.current = Date.now();
        gistId = await createRemote(token, { subs, checked, updatedAt: updatedAtRef.current });
        cfg = { token, gistId };
        saveSyncConfig(cfg);
        setSyncCfg(cfg);
        setSyncState("ok");
      }
      setTokenInput("");
    } catch (e) {
      setSyncError(
        e.status === 401
          ? "トークンが無効です。「gist」権限が付いているか・有効期限内かを確認してください。"
          : "接続に失敗しました。通信環境を確認してもう一度お試しください。"
      );
    } finally {
      setSyncBusy(false);
    }
  };

  const stopSync = () => {
    clearSyncConfig();
    setSyncCfg(null);
    setSyncState("off");
  };

  // 2台目以降はこのリンクを開くだけで同期に参加できる
  const copyDeviceLink = async () => {
    const url = window.location.origin + window.location.pathname + toSyncHash(syncCfg);
    try {
      await navigator.clipboard.writeText(url);
      setDeviceLinkState("copied");
      setTimeout(() => setDeviceLinkState("idle"), 2000);
    } catch (e) {
      window.prompt("このリンクを追加したい端末で開いてください", url);
    }
  };

  const selected = subs.filter((s) => checked.includes(s.id));
  const selectedTotal = selected.reduce((a, s) => a + monthlyOf(s), 0);
  const selectedYearly = selected.reduce((a, s) => a + yearlyOf(s), 0);
  const grandTotal = subs.reduce((a, s) => a + monthlyOf(s), 0);
  const animated = useCountUp(Math.round(selectedTotal));
  const ratio = grandTotal > 0 ? selectedTotal / grandTotal : 0;
  const sorted = [...subs].sort((a, b) => daysUntil(a) - daysUntil(b));

  const css = `
    .sm{--bg:#0C0D12;--sur:#14161E;--sur2:#1B1E29;--line:#262A36;--txt:#EDEEF2;--mut:#7D8190;
      --acc:#7C7AFF;--acc2:#4E4BE0;--glow:rgba(124,122,255,.28);
      font-family:'Noto Sans JP',system-ui,sans-serif;background:var(--bg);color:var(--txt);
      min-height:100vh;-webkit-font-smoothing:antialiased}
    .sm *{box-sizing:border-box}
    .mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}

    /* 背景の環境光 */
    .sm-aura{position:fixed;inset:0;pointer-events:none;
      background:radial-gradient(600px 320px at 50% -80px,rgba(124,122,255,.14),transparent 70%)}

    .sm-header{position:sticky;top:0;z-index:10;
      background:rgba(12,13,18,.78);backdrop-filter:blur(14px);
      border-bottom:1px solid var(--line)}
    .sm-hin{max-width:640px;margin:0 auto;padding:18px 20px 14px}
    .sm-hrow{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    .sm-brand{font-size:12px;font-weight:700;letter-spacing:.18em;color:var(--mut)}
    .sm-save{font-size:10px;color:var(--mut);letter-spacing:.08em;margin-top:4px;min-height:14px}
    .sm-save.err{color:#FF7B6B}
    .sm-syncbtn{background:none;border:none;padding:2px 0;margin-top:2px;font-family:inherit;
      font-size:11px;color:var(--acc);cursor:pointer;letter-spacing:.04em;text-align:left}
    .sm-syncbtn.err{color:#FF7B6B}
    .sm-note{font-size:12px;color:var(--mut);line-height:1.9;margin:0 0 14px}
    .sm-note a{color:var(--acc)}
    .sm-warn{font-size:11px;color:#FFB88C;line-height:1.7;margin:8px 0 12px}
    .sm-syncstate{font-size:12px;color:var(--mut);margin:0 0 14px}
    .sm-primary:disabled{opacity:.5;cursor:default}
    .sm-tlabel{font-size:10px;color:var(--mut);letter-spacing:.14em;text-align:right}
    .sm-total{font-size:34px;font-weight:600;line-height:1.1;text-align:right;
      background:linear-gradient(120deg,#EDEEF2 30%,var(--acc) 100%);
      -webkit-background-clip:text;background-clip:text;color:transparent;
      text-shadow:0 0 32px var(--glow)}
    .sm-tsub{font-size:11px;color:var(--mut);text-align:right;margin-top:3px}
    /* 選択比率ゲージ */
    .sm-gauge{height:3px;border-radius:2px;background:var(--sur2);margin-top:14px;overflow:hidden}
    .sm-gauge i{display:block;height:100%;border-radius:2px;
      background:linear-gradient(90deg,var(--acc2),var(--acc));
      box-shadow:0 0 10px var(--glow);transition:width .45s cubic-bezier(.22,1,.36,1)}

    .sm-main{max-width:640px;margin:0 auto;padding:22px 20px 60px;position:relative}
    .sm-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
    .sm-count{font-size:12px;color:var(--mut)}
    .sm-link{background:none;border:none;color:var(--acc);font-size:12px;cursor:pointer;
      padding:4px;font-family:inherit;letter-spacing:.04em}

    /* カード */
    .sm-card{display:flex;align-items:center;gap:14px;padding:16px;margin-bottom:10px;
      background:var(--sur);border:1px solid var(--line);border-radius:14px;
      transition:transform .18s,border-color .18s,box-shadow .18s;cursor:pointer}
    .sm-card:hover{transform:translateY(-1px);border-color:#333848}
    .sm-card.on{border-color:var(--acc2);background:linear-gradient(180deg,var(--sur2),var(--sur));
      box-shadow:0 0 0 1px var(--acc2),0 8px 28px -12px var(--glow)}
    /* カスタムチェック */
    .sm-chk{width:22px;height:22px;border-radius:50%;border:1.5px solid var(--mut);
      flex-shrink:0;display:grid;place-items:center;transition:all .18s;background:transparent}
    .on .sm-chk{border-color:var(--acc);background:var(--acc);box-shadow:0 0 12px var(--glow)}
    .sm-chk svg{opacity:0;transform:scale(.5);transition:all .18s}
    .on .sm-chk svg{opacity:1;transform:scale(1)}
    .sm-info{flex:1;min-width:0}
    .sm-name{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sm-meta{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap}
    .sm-daybadge{font-size:10px;padding:2px 8px;border-radius:99px;background:var(--sur2);
      border:1px solid var(--line);color:var(--mut);letter-spacing:.04em;white-space:nowrap}
    .sm-soon{color:#FFB88C;border-color:rgba(255,184,140,.35);background:rgba(255,184,140,.08)}
    .sm-price{font-size:17px;font-weight:600;white-space:nowrap;text-align:right}
    .sm-price small{font-size:10px;color:var(--mut);font-weight:400;margin-left:2px}
    .sm-permo{font-size:10px;color:var(--mut);font-weight:400;margin-top:2px}
    .sm-acts{display:flex;flex-direction:column;gap:2px;flex-shrink:0}
    .sm-ic{background:none;border:none;color:var(--mut);cursor:pointer;padding:4px 8px;
      font-size:11px;border-radius:6px;font-family:inherit}
    .sm-ic:hover{background:var(--sur2);color:var(--txt)}

    .sm-add{width:100%;margin-top:10px;padding:15px;border:1px dashed #333848;border-radius:14px;
      background:none;color:var(--acc);font-size:14px;font-weight:600;cursor:pointer;
      font-family:inherit;transition:all .18s;letter-spacing:.04em}
    .sm-add:hover{border-color:var(--acc);background:rgba(124,122,255,.06);box-shadow:0 0 20px -8px var(--glow)}
    .sm-empty{text-align:center;padding:56px 0;color:var(--mut);font-size:13px;line-height:2}

    .sm-form{border:1px solid var(--line);border-radius:16px;padding:20px;margin-top:12px;
      background:var(--sur);box-shadow:0 20px 50px -20px rgba(0,0,0,.6)}
    .sm-form h3{margin:0 0 16px;font-size:13px;font-weight:700;letter-spacing:.08em}
    .sm-field{margin-bottom:13px}
    .sm-label{display:block;font-size:10px;color:var(--mut);margin-bottom:6px;letter-spacing:.12em}
    .sm-input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;
      font-size:15px;font-family:inherit;background:var(--bg);color:var(--txt)}
    .sm-input:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
    .sm-frow{display:flex;gap:10px}
    .sm-frow .sm-field{flex:1}
    /* 支払いサイクル切替 */
    .sm-seg{display:flex;gap:4px;padding:3px;background:var(--bg);border:1px solid var(--line);border-radius:10px}
    .sm-segbtn{flex:1;padding:9px;border:none;border-radius:8px;background:none;color:var(--mut);
      font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .18s}
    .sm-segbtn.on{background:var(--sur2);color:var(--txt);box-shadow:0 0 0 1px var(--acc2),0 0 14px -6px var(--glow)}
    .sm-btns{display:flex;gap:8px;margin-top:8px}
    .sm-primary{flex:1;padding:12px;border:none;border-radius:10px;
      background:linear-gradient(120deg,var(--acc2),var(--acc));color:#fff;
      font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:.04em;
      box-shadow:0 6px 20px -8px var(--glow)}
    .sm-ghost{padding:12px 18px;border:1px solid var(--line);border-radius:10px;background:none;
      color:var(--mut);font-size:14px;cursor:pointer;font-family:inherit}
    @media(prefers-reduced-motion:reduce){.sm *{transition:none!important}}
  `;

  if (loading) {
    return (
      <div className="sm" style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <style>{css}</style>
        <span style={{ fontSize: 12, color: "#7D8190" }}>読み込み中…</span>
      </div>
    );
  }

  return (
    <div className="sm">
      <style>{css}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap"
        rel="stylesheet"
      />
      <div className="sm-aura" />

      <header className="sm-header">
        <div className="sm-hin">
          <div className="sm-hrow">
            <div>
              <div className="sm-brand">SUBSCRIPTIONS</div>
              <div className="sm-save">
                {saveState === "saving" && "保存中…"}
                {saveState === "saved" && "✓ 保存済み"}
                {saveState === "error" && <span className="err">保存に失敗しました</span>}
              </div>
              <button
                className={"sm-syncbtn" + (syncCfg && syncState === "error" ? " err" : "")}
                onClick={() => setShowSync((v) => !v)}
              >
                {!syncCfg && "端末間の同期を設定"}
                {syncCfg && syncState === "error" && "⚠ 同期エラー"}
                {syncCfg && syncState === "syncing" && "↻ 同期中…"}
                {syncCfg && (syncState === "ok" || syncState === "off") && "✓ 端末間で同期中"}
              </button>
            </div>
            <div>
              <div className="sm-tlabel">選択中の合計 / {checked.length}件</div>
              <div className="sm-total mono">{yen(animated)}</div>
              <div className="sm-tsub mono">年間 {yen(selectedYearly)}・全体 {yen(grandTotal)} / 月</div>
            </div>
          </div>
          <div className="sm-gauge" aria-hidden="true">
            <i style={{ width: `${ratio * 100}%` }} />
          </div>
        </div>
      </header>

      <main className="sm-main">
        {showSync && (
          <div className="sm-form" style={{ marginTop: 0, marginBottom: 16 }}>
            <h3>端末間の同期</h3>
            {!syncCfg ? (
              <>
                <p className="sm-note">
                  GitHub の非公開 Gist にデータを保存して、スマホと PC で同じデータを表示します。
                  <br />
                  1.{" "}
                  <a href={TOKEN_URL} target="_blank" rel="noreferrer">
                    GitHub でアクセストークンを作成
                  </a>
                  (権限は「gist」のみ。リンク先で設定済み)
                  <br />
                  2. 生成されたトークン(ghp_…)を下に貼り付けて「同期を開始」
                  <br />
                  3. 開始後に表示される「別の端末を追加」リンクをスマホで開く
                </p>
                <div className="sm-field">
                  <label className="sm-label">アクセストークン</label>
                  <input
                    className="sm-input mono"
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxx"
                  />
                </div>
                {syncError && <p className="sm-warn">{syncError}</p>}
                <div className="sm-btns">
                  <button className="sm-primary" onClick={startSync} disabled={syncBusy || !tokenInput.trim()}>
                    {syncBusy ? "接続中…" : "同期を開始"}
                  </button>
                  <button className="sm-ghost" onClick={() => setShowSync(false)}>閉じる</button>
                </div>
              </>
            ) : (
              <>
                <p className="sm-syncstate">
                  {syncState === "error"
                    ? "⚠ 同期に失敗しました。通信環境とトークンの有効期限を確認してください。"
                    : "✓ この端末は同期中です。変更は自動で他の端末にも反映されます。"}
                </p>
                <div className="sm-btns">
                  <button className="sm-primary" onClick={copyDeviceLink}>
                    {deviceLinkState === "copied" ? "✓ コピーしました" : "別の端末を追加(リンクをコピー)"}
                  </button>
                </div>
                <p className="sm-warn">
                  このリンクを開いた端末が同期に参加します。同期用トークンを含むため、
                  自分宛てのメモや AirDrop など安全な方法で送ってください。
                </p>
                <div className="sm-btns">
                  <button className="sm-ghost" onClick={() => reconcile()}>今すぐ同期</button>
                  <button className="sm-ghost" onClick={stopSync}>同期を解除</button>
                  <button className="sm-ghost" onClick={() => setShowSync(false)}>閉じる</button>
                </div>
              </>
            )}
          </div>
        )}

        {subs.length > 0 && (
          <div className="sm-bar">
            <span className="sm-count">{subs.length}件・引き落としが近い順</span>
            <span>
              <button className="sm-link" onClick={copyShareLink}>
                {shareState === "copied" ? "✓ コピーしました" : "共有リンク"}
              </button>
              <button className="sm-link" onClick={toggleAll}>
                {checked.length === subs.length ? "全て解除" : "全て選択"}
              </button>
            </span>
          </div>
        )}

        {subs.length === 0 && !showForm && (
          <div className="sm-empty">
            まだ登録がありません。<br />「＋ サブスクを追加」から始めましょう。
          </div>
        )}

        {sorted.map((s) => {
          const d = daysUntil(s);
          const on = checked.includes(s.id);
          const yearly = s.cycle === "yearly";
          return (
            <div
              key={s.id}
              className={"sm-card" + (on ? " on" : "")}
              onClick={() => toggle(s.id)}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(s.id); } }}
            >
              <span className="sm-chk">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6.5L4.8 9L10 3.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="sm-info">
                <div className="sm-name">{s.name}</div>
                <div className="sm-meta">
                  <span className={"sm-daybadge mono" + (d <= 7 ? " sm-soon" : "")}>
                    {yearly ? `毎年${s.month}月${s.day}日` : `毎月${s.day}日`}
                    {d === 0 ? "・今日" : d <= 7 ? `・あと${d}日` : ""}
                  </span>
                  {yearly && <span className="sm-daybadge">年払い</span>}
                </div>
              </div>
              <div className="sm-price mono">
                {yen(s.price)}<small>/{yearly ? "年" : "月"}</small>
                {yearly && <div className="sm-permo mono">月あたり {yen(monthlyOf(s))}</div>}
              </div>
              <div className="sm-acts" onClick={(e) => e.stopPropagation()}>
                <button className="sm-ic" onClick={() => openEdit(s)}>編集</button>
                <button className="sm-ic" onClick={() => remove(s.id)}>削除</button>
              </div>
            </div>
          );
        })}

        {showForm ? (
          <div className="sm-form">
            <h3>{editingId ? "サブスクを編集" : "サブスクを追加"}</h3>
            <div className="sm-field">
              <label className="sm-label">サービス名</label>
              <input
                className="sm-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Netflix"
                autoFocus
              />
            </div>
            <div className="sm-field">
              <label className="sm-label">支払いサイクル</label>
              <div className="sm-seg" role="radiogroup" aria-label="支払いサイクル">
                {[["monthly", "月払い"], ["yearly", "年払い"]].map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={form.cycle === v}
                    className={"sm-segbtn" + (form.cycle === v ? " on" : "")}
                    onClick={() => setForm({ ...form, cycle: v })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm-frow">
              <div className="sm-field">
                <label className="sm-label">{form.cycle === "yearly" ? "年額(円)" : "月額(円)"}</label>
                <input
                  className="sm-input mono"
                  type="number" min="0"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder={form.cycle === "yearly" ? "13800" : "1490"}
                />
              </div>
              {form.cycle === "yearly" && (
                <div className="sm-field">
                  <label className="sm-label">引き落とし月(1〜12)</label>
                  <input
                    className="sm-input mono"
                    type="number" min="1" max="12"
                    value={form.month}
                    onChange={(e) => setForm({ ...form, month: e.target.value })}
                    placeholder="4"
                  />
                </div>
              )}
              <div className="sm-field">
                <label className="sm-label">引き落とし日(1〜31)</label>
                <input
                  className="sm-input mono"
                  type="number" min="1" max="31"
                  value={form.day}
                  onChange={(e) => setForm({ ...form, day: e.target.value })}
                  placeholder="27"
                />
              </div>
            </div>
            <div className="sm-btns">
              <button className="sm-primary" onClick={submit}>
                {editingId ? "変更を保存" : "追加する"}
              </button>
              <button className="sm-ghost" onClick={() => setShowForm(false)}>キャンセル</button>
            </div>
          </div>
        ) : (
          <button className="sm-add" onClick={openAdd}>＋ サブスクを追加</button>
        )}
      </main>
    </div>
  );
}
