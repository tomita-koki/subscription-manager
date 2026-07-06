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
- **端末間の自動同期**: スマホと PC で同じデータを表示(GitHub Gist 利用・下記参照)
- `#import=<base64url JSON>` 付き URL を開くと一括登録(同じ id は取り込まないので再クリックしても重複なし)

## 端末間の同期

サーバー不要のまま、自分の GitHub アカウントの**非公開 Gist** をデータ置き場にして同期します。

1. ヘッダーの「端末間の同期を設定」を開く
2. [gist 権限のみのアクセストークン](https://github.com/settings/tokens/new?scopes=gist&description=subscription-manager-sync)を作成して貼り付け →「同期を開始」
3. 「別の端末を追加(リンクをコピー)」で出る URL をスマホで開くと、その端末も同期に参加

仕組み(`src/sync.js`):

- 変更は保存(500ms デバウンス)と同時に Gist へ push
- タブへの復帰時と 60 秒ごとに Gist を pull し、`updatedAt` が新しい方を採用(Last-Write-Wins)。
  ローカルの方が新しければ逆に push するので、オフライン中の変更も後から反映される
- 同期設定(トークン + Gist ID)は各端末の `localStorage` にのみ保存。
  「別の端末を追加」リンクにはトークンが含まれるため、自分宛て以外に共有しないこと
- 同期を解除してもデータは消えない(各端末のローカル保存はそのまま)

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
