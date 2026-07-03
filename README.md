# サブスク管理アプリ

契約中のサブスクリプションを一覧管理し、任意の組み合わせの合計金額を確認できる React アプリ。

![stack](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white&labelColor=0C0D12)
![stack](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white&labelColor=0C0D12)

## 機能

- サブスクの登録・編集・削除(サービス名 / 月額 / 引き落とし日)
- チェックした項目だけの合計をヘッダーに常時表示(カウントアップ演出付き)
- 全体に対する選択割合のゲージ表示
- 引き落としが近い順に自動ソート、7日以内は「あと◯日」バッジ
- データはブラウザに自動保存(リロードしても消えない)

## 技術メモ

- **永続化**: `src/storage.js` のアダプタ経由。通常ブラウザでは `localStorage`、
  Claude アーティファクト内では `window.storage` を自動選択
- 保存は変更のたびに 500ms デバウンスで実行
- 外部ライブラリ依存なし(React のみ)。CSS はコンポーネント内に同梱

## 開発

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ に出力
```

## デプロイ

静的サイトとしてどこでも動きます(Vercel / Netlify / GitHub Pages)。

GitHub Pages の場合は `vite.config.js` に `base: "/subscription-manager/"` を追加してください。
