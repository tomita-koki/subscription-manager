# サブスク管理アプリ

契約中のサブスクリプションを一覧管理し、任意の組み合わせの合計金額を確認できる React アプリ。

![stack](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white&labelColor=0C0D12)
![stack](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white&labelColor=0C0D12)

## 機能

- サブスクの登録・編集・削除(サービス名 / 金額 / 引き落とし日)
- 月払い・年払いの両方に対応(年払いは月額換算で合計に反映)
- チェックした項目だけの合計をヘッダーに常時表示(カウントアップ演出付き)
- 選択中の年間コストも同時表示
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

`main` に push すると GitHub Actions(`.github/workflows/deploy.yml`)が自動で
GitHub Pages にデプロイします。`vite.config.js` の `base` は Actions 上のビルドでのみ
`/subscription-manager/` に切り替わるため、ローカル開発はルートパスのままです。

静的サイトなので Vercel / Netlify などでもそのまま動きます。
