# TODO

上から順に一つずつ進める。各タスクの「完了条件」が通ったらチェックを入れる。段階の途中で設計を変えたくなったら `DECISIONS.md` に書いてから。

## 一旦の完成とは

Cloudflare上で、Accessを通ってログインすると今日の日付ページが開き、閲覧・検索・バックリンク・2 hop linkが動き、ページをその場で編集して保存するとGitHubにコミットされ、`settings` の `script.js` のマクロがブラウザで展開され、`/new` と `/append` でブックマークレットから取り込める。ここまでを「一旦の完成」とする。Androidの共有メニュー（`share_target`）と `#要約待ち` 系はその後。

## 人待ち

AIには権限がなく、人がやる必要があること。上から順にやる（Accessで保護する前にトークンを登録しない）。終わったらチェックを入れる。

- [x] Workers Buildsにこのリポジトリをつなぐ。プロジェクト名 `web-b2`、ビルドコマンド `npm run build`、デプロイコマンド `npx wrangler deploy`（既定のまま）、プレビュービルドは有効、本番ブランチ `main`。「Protect with Cloudflare Access」をオンにし、ポリシーは Cloudflare account members にする。段階1が終わるまでビルドは失敗する
- [x] Workerの「Access」タブで、Worker Access が「すべてのトラフィック」（本番とプレビュー）、ポリシーが Cloudflare account members の許可になっていることを確かめる
- [x] 段階1でデプロイが成功したら、「ドメイン」タブの Worker URL で、プロダクション（`web-b2.<サブドメイン>.workers.dev`）のスイッチをオンにする。PRごとのプレビューを見たければプレビューもオンにする（どちらもAccessの対象）
- [x] シークレットウィンドウで `https://web-b2.<サブドメイン>.workers.dev/` を開き、Cloudflareのログイン画面が出ることを確かめる。出なければトークンを登録せずに止める
- [x] Workerの雛形のPRのプレビュー（またはマージ後の本番）で、ログインしてから `/api/whoami` を開き、表示された `access`・`jwtHeader`・`cookie` の true/false を `TODO.md` か会話で伝える。値は出ず、有無だけが出る
  - 結果は `access` が false、`jwtHeader` と `cookie` が true。
- [x] Workerの Settings > Variables and Secrets で、`ACCESS_TEAM_DOMAIN`（`https://<チーム名>.cloudflareaccess.com`）と `ACCESS_AUD` を Secret として登録する。AUDは Zero Trust の Access > Applications でこのWorkerのアプリを開くと「Application Audience (AUD) Tag」として出る（one-click Access のアプリがそこに並ぶかは未確認）。見つからなければ、ログイン後にブラウザの開発者ツールで `CF_Authorization` クッキーのJWTを base64url で解読し、本文の `aud` を使う
- [x] 登録後にログインして `/api/pages` を開き、401ではなく501（`{"error":"まだない"}`）が返ることを確かめる。401ならトークンを登録せずに止める
  - Secret と AUD を登録しても401のままだった。原因は、Previews Base のシークレットが既存のプレビューに反映されないことだった。調べるために401の本文へ一時的に入れた理由の表示は消した。
  - 本番でも401だったのは、プロダクション側がシークレットではなくテキストの変数で登録されていて、`wrangler deploy` で消えたためと推測している（未確認）。シークレットで登録し直すと `{"error":"まだない"}` になった（2026-09-27）。AUDは、ログイン画面への転送先URLの `kid=` の値と同じだった。
  - 以後、Workerの設定値は「設定」タブで、プロダクションと Previews Base の両方に、タイプを「シークレット」にして登録する。Previews Base のシークレットは、登録した後に作られたプレビュー（新しいブランチの最初のpush）にしか入らない。
- [ ] GitHubの Settings > Developer settings > Personal access tokens > Fine-grained tokens で、Repository access を知識庫リポジトリだけ、Repository permissions を Contents: Read and write だけにしたトークンを作る。期限の日を控える
- [ ] Workerの Settings > Variables and Secrets で、`GITHUB_TOKEN` と `KB_REPO`（`owner/repo`）を Secret として登録する。公開リポジトリの wrangler 設定には書かない

## 段階1 雛形とローカルモード

- [x] `package.json`、TypeScript、Vite、vitest、Playwright、wrangler を入れ、`npm test`・`npm run e2e`・`npm run dev:local`・`npm run build` のスクリプトを用意する。CI（GitHub Actions）で `npm test` と `npm run e2e` を回す。完了条件: `npm test` と `npm run e2e` がそれぞれ1件以上のテストで通り、Actionsが緑
  - `dev:local` は今はViteの開発サーバーを起動するだけで、`/api/*` はない。e2eはこれをポート5199で起動する。`wrangler.jsonc` は静的ファイル（`dist/`）だけの設定なので、Workerの雛形のタスクで `main` を足す。
- [x] ローカルモードのサーバー（Node.js）を作る。`KB_ROOT` の下の `KB_DIR` から `.md` を列挙・取得・書き込み・添付ファイル取得する `/api/*` を返す。完了条件: `fixtures/` を `KB_ROOT` にして、一覧・取得・書き込みの単体テストが通る
  - `src/server/local.ts` がAPI本体で、Viteのプラグイン（`src/server/vite-plugin.ts`）で `dev:local` の開発サーバーに載る。`KB_ROOT` の既定は `fixtures`。`PUT` は `sha` を受け取るが、まだ比べていない（競合の検出のタスクで足す）。
  - Windowsで `core.autocrlf=true` だと `fixtures/` の作業ツリーがCRLFになり、ローカルモードはCRLFのまま返す。Markdownの解析はCRLFでも同じ結果になるようにする。
- [x] Workerの雛形を作る。静的ファイルと `/api/*` の振り分け、`ctx.access` がないリクエストを401にする（テストでは差し替えられるようにする）。完了条件: `wrangler dev` で `/` が200、`ctx.access` なしの `/api/pages` が401
  - `src/worker/index.ts`。`wrangler.jsonc` の `run_worker_first` で `/api/*` だけがWorkerに来る。テストは `createHandler` に鍵の取得と時刻を差し替えた検証関数を渡す。`wrangler dev` は `dist/` を配るので先に `npm run build` が要る。
  - Cloudflareのドキュメント（workers/configuration/cloudflare-access）に、静的ファイルを持つWorkerには `ctx.access` が渡らないとある。本番で何が届くかを見るため、有無だけを返す `/api/whoami` を入れて確かめ、次のタスクで消した。
- [x] 人待ちの `/api/whoami` の結果で、Workerでの認証の確かめ方を決める。`Cf-Access-Jwt-Assertion` が届いていれば、WorkerでJWTを検証する（WebCrypto、ライブラリは足さない）。先に `DECISIONS.md` と `SPEC.md` を直し、`/api/whoami` を消す。完了条件: 決めた方法で、認証なしの `/api/pages` が401になる単体テストが通る
  - `src/worker/access.ts`。鍵は1時間使い回し、知らない `kid` が来たら（前回の取得から1分空いていれば）取り直す。鍵を取れないときも401。テストは `jwt-test-helper.ts` で作ったRSAの鍵とJWTを使う。

## 段階2 ブラウザ側の索引

- [ ] Markdownの解析（front matter、H1、リンク、タグ、コードブロックの除外）を実装する。完了条件: `fixtures/` の全ページで期待どおりの `title`・`links` になる単体テストが通る
- [ ] 索引（`name`→ページ、`title`→`name`、リンク先→リンク元）と、リンクの解決（`name`→`title`→まだないページ）を実装する。完了条件: 解決順・バックリンク・2 hop linkの単体テストが通る
- [ ] IndexedDBへの保存と、変わったファイルだけ読み直す仕組みを作る。完了条件: 2回目の読み込みで全ファイルを取り直さない単体テストが通る
- [ ] 1万ページの合成データで計測し、`SPEC.md` の目標に収まることを確かめる。完了条件: 計測結果を `docs/perf.md` に書く

## 段階3 表示と検索

- [ ] `/p/<name>` でページを表示する。marked、Mermaid、`[[リンク]]`、`#タグ`、作成日・更新日、まだないページ、`.md` リンクの転送。完了条件: e2eで見本ページが表示され、リンクをクリックして遷移できる
- [ ] バックリンクと2 hop linkをページ末尾に出す。完了条件: e2eで見本ページの末尾に期待どおりのリンクが出る
- [ ] 検索欄（固定、AND、IME対応）と `/all`。完了条件: e2eで検索語を入力すると結果が差し替わり、`/all?q=` に残る
- [ ] `settings` ページの読み取り（トップ、ヘッダー、`style.css`）と `/` の振り分け。完了条件: e2eで `/` が今日の日付ページになり、ヘッダーのリンクが `settings` の内容になる

## 段階4 マクロ

- [ ] `{{名前 引数}}` の展開（コード内は除外、未登録は残す）と、`settings` の `script.js` のブラウザでの実行、`kb` API。完了条件: `fixtures/` の `settings` に定義したマクロが表示で展開される単体テストとe2eが通る
- [ ] スクリプトの構文エラーを `settings` ページの先頭に出す。完了条件: e2eで壊れたスクリプトを保存するとエラーが表示される

## 段階5 編集と保存

- [ ] CodeMirror 6でページをその場で編集する。完了条件: e2eで本文を書き換えると表示に反映される
- [ ] 保存のタイミング（入力停止・ページ移動・タブを閉じる）と、ローカルモードでの書き込み。`updated` の更新。完了条件: e2eで編集後にファイルが変わっている
- [ ] 新しいページの作成（ファイル名は時刻、`KB_DIR` の直下）。完了条件: e2eでまだないページに書き込むとファイルができる
- [ ] 競合の検出（SHA不一致で上書きしない）。完了条件: 単体テストで、裏で変えたファイルへの保存が拒否され、両方の内容が返る

## 段階6 GitHub中継

- [ ] Workerの `/api/*` をGitHub Contents API・tarball・compare で実装する。完了条件: GitHub APIをモックした単体テストが通る
  - `/api/files/<path>` と `/api/pages/<path>` で、ドットで始まる区切り（`.git`、`.github` など）を含むパスは400にする。ローカルモード（`src/server/local.ts`）にも同じ制限を入れ、両方のテストで確かめる。
- [ ] ブラウザの初回読み込み（tarball）と差分更新（compare）をWorker経由でつなぐ。完了条件: モックで、初回は全件、2回目は差分だけ読むテストが通る
- [ ] 本番へデプロイして、Accessを通って自分のknowledgeを開けることを確かめる。完了条件: 人が確認する（ここで止まって報告する）

## 段階7 取り込み

- [ ] `/new?title=&body=` と `/append?page=&body=`。完了条件: e2eで両方のURLからページが作られる・追記される
- [ ] `README.md` にブックマークレットの例と、Cloudflare側の設定手順を書く。完了条件: 人が読んで手順どおりに設定できる

## 完成後

- [ ] PWAのマニフェストと `share_target`
- [ ] `kb.command` の呼び出し方（右クリックか `/名前`）を決めて実装する
- [ ] ページアイコン `[[名前.icon]]`
- [ ] 全文検索が遅くなったらtrigram索引
