import { useState, useEffect, useRef } from "react";
import { storage } from "./storage.js";

const STORAGE_KEY = "subman:data";

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
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", price: "", day: "", cycle: "monthly", month: "" });
  const loaded = useRef(false);
  const initStarted = useRef(false);
  const saveTimer = useRef(null);

  // ---- 読み込み ----
  useEffect(() => {
    // StrictMode の二重実行ガード(ハッシュ消費が1回きりのため必須)
    if (initStarted.current) return;
    initStarted.current = true;
    (async () => {
      let subs0 = [];
      let checked0 = [];
      try {
        const result = await storage.get(STORAGE_KEY);
        if (result && result.value) {
          const data = JSON.parse(result.value);
          // 旧データ(cycle なし)は月払いとして扱う
          subs0 = (Array.isArray(data.subs) ? data.subs : []).map((s) =>
            s.cycle ? s : { ...s, cycle: "monthly" }
          );
          checked0 = Array.isArray(data.checked) ? data.checked : [];
        }
      } catch (e) {
        // 初回起動(キー未作成)は空でOK
      }
      // ---- URL からの取り込み(#import=<base64url JSON>)----
      // 同じ id は取り込まないので、リンクを複数回開いても重複しない
      try {
        const m = window.location.hash.match(/^#import=([A-Za-z0-9\-_]+)$/);
        if (m) {
          const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
          const payload = JSON.parse(json);
          const existing = new Set(subs0.map((s) => s.id));
          const incoming = (Array.isArray(payload.subs) ? payload.subs : []).filter(
            (s) =>
              s && typeof s.id === "string" && !existing.has(s.id) &&
              typeof s.name === "string" && s.name.trim() &&
              Number.isFinite(s.price) && s.price >= 0 &&
              Number.isInteger(s.day) && s.day >= 1 && s.day <= 31 &&
              (s.cycle === "monthly" ||
                (s.cycle === "yearly" && Number.isInteger(s.month) && s.month >= 1 && s.month <= 12))
          );
          subs0 = [...subs0, ...incoming];
          checked0 = [...checked0, ...incoming.map((s) => s.id)];
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      } catch (e) {
        // 壊れたインポートデータは無視
      }
      setSubs(subs0);
      setChecked(checked0);
      loaded.current = true;
      setLoading(false);
    })();
  }, []);

  // ---- 自動保存 ----
  useEffect(() => {
    if (!loaded.current) return;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await storage.set(STORAGE_KEY, JSON.stringify({ subs, checked }));
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1600);
      } catch (e) {
        setSaveState("error");
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [subs, checked]);

  // ---- 操作 ----
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
    if (editingId) {
      setSubs((p) => p.map((s) => (s.id === editingId ? { id: s.id, ...entry } : s)));
    } else {
      const id = crypto.randomUUID();
      setSubs((p) => [...p, { id, ...entry }]);
      setChecked((p) => [...p, id]); // 追加時はデフォルトで合計に含める
    }
    setShowForm(false);
  };
  const remove = (id) => { setSubs((p) => p.filter((s) => s.id !== id)); setChecked((p) => p.filter((c) => c !== id)); };
  const toggle = (id) => setChecked((p) => (p.includes(id) ? p.filter((c) => c !== id) : [...p, id]));
  const toggleAll = () => setChecked((p) => (p.length === subs.length ? [] : subs.map((s) => s.id)));

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
        {subs.length > 0 && (
          <div className="sm-bar">
            <span className="sm-count">{subs.length}件・引き落としが近い順</span>
            <button className="sm-link" onClick={toggleAll}>
              {checked.length === subs.length ? "全て解除" : "全て選択"}
            </button>
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
