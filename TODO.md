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
- [x] GitHubの Settings > Developer settings > Personal access tokens > Fine-grained tokens で、Repository access を知識庫リポジトリだけ、Repository permissions を Contents: Read and write だけにしたトークンを作る。期限の日を控える
- [x] Workerの Settings > Variables and Secrets で、`GITHUB_TOKEN` と `KB_REPO`（`owner/repo`）を Secret として登録する。公開リポジトリの wrangler 設定には書かない
- [ ] `README.md` の「Cloudflare に置く」を読み、実際にした設定と食い違いがないか確かめる。とくにダッシュボードの項目名（「設定」タブ、Previews Base、「ドメイン」タブの Worker URL）と、シークレットを登録しただけで本番に反映されたか
- [ ] PC の Chrome で `README.md` の3つのブックマークレットを入れて押し、確認画面に title と本文が期待どおり出て、保存できることを確かめる。日本語を直に書いた「あとで読む」と `(以下略)` が動くかも見る
- [ ] Android の Chrome で /new のブックマークレットを、アドレスバーにブックマークの名前を打つ方法で押す。動くか、`window.open` で新しいタブが開くか（開かなければ `location.href=u` の形で試す）、選択範囲が残るかを記録する
- [ ] URL の長さの上限。ログインしたアプリのタブで、開発者ツールのコンソールから `location.href = '/new?body=' + encodeURIComponent('あ'.repeat(N))` を N = 500, 1000, 1500, 2000 で開き（URL はおよそ 9N 文字）、本文が欠けずに出る最大の N と、超えたときに何が出るか（414 か、Cloudflare のエラーページか）を記録する
- [ ] ログインが切れているときにクエリが残るか。ログインしたタブのコンソールで `copy(location.origin + '/new?title=x&body=' + encodeURIComponent('あ'.repeat(500)))` を実行して URL をコピーし、シークレットウィンドウに貼って開く。ログインの後に確認画面の title と本文が残るかと、ログインを挟むと上の上限が下がるかを記録する
  - 結果が出たら、`README.md` の「未確認」を外すか書き直し、/new の例の `M`（6000）を直す。

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

- [x] Markdownの解析（front matter、H1、リンク、タグ、コードブロックの除外）を実装する。完了条件: `fixtures/` の全ページで期待どおりの `title`・`links` になる単体テストが通る
  - `src/client/page.ts` の `parsePage`。`maskCode` はコード（囲い・インライン）を位置を変えずに別の文字で埋めるので、マクロの展開でも同じものを使う。front matterは `key: value`・`[a, b]`・`- a` だけ読み、`updated` がなければ `null`。
  - `SPEC.md` どおり `#` は行頭か空白の直後だけタグにするので、見本の読書リストの「）#読了」はタグにならない（テストもそう書いた）。全角の括弧の直後も許すなら `SPEC.md` を直す。`settings` の `[[{{date}}]]` は展開前の `{{date}}` がリンクになる。
- [x] 索引（`name`→ページ、`title`→`name`、リンク先→リンク元）と、リンクの解決（`name`→`title`→まだないページ）を実装する。完了条件: 解決順・バックリンク・2 hop linkの単体テストが通る
  - `src/client/kb-index.ts` の `KbIndex`。`set`/`remove` で1ページずつ差し替えられるので、差分更新でも作り直さない。逆引きはリンクに書かれた文字のまま持ち、`backlinks(ref)` で name と title の両方を引く。2 hop link はリンク先を解決してからまとめるので、name で書いたリンクと title で書いたリンクは同じグループになる。
  - 並びは `byUpdatedDesc`（`updated` の新しい順、同じなら `name` の降順、`updated` なしは最後）にそろえた。一覧と検索でも同じものを使う。
- [x] IndexedDBへの保存と、変わったファイルだけ読み直す仕組みを作る。完了条件: 2回目の読み込みで全ファイルを取り直さない単体テストが通る
  - `src/client/store.ts`（`FileStore`。IndexedDBの `IdbStore` とテスト用の `MemoryStore`）と `src/client/sync.ts`（`sync(store, source)`）。控えには解析結果ではなく `path`・`sha`・中身をそのまま置く（`DECISIONS.md` 2026-09-27）。読めた分は200件ごとに控えへ書き、途中で失敗しても次回はそこから続く。一覧に出たあとで消えたファイル（404）は「消えた」として扱う。
  - 取り込み元は `Source`（一覧と1ページの取得）で差し替えられる。いまは `/api/pages` を使う `ApiSource` だけで、段階6で tarball と compare のものを足す。`store.getMeta/setMeta` は最後に見たコミットを置く場所として先に用意した。差分を取れないとき（オフラインなど）は `main.ts` が控えだけで索引を作る。
  - `IdbStore` は単体テストでは動かせない（Node.jsにIndexedDBがない）ので、`e2e/sync.spec.ts` で2回目の読み込みに `/api/pages/<path>` のリクエストが出ないことを確かめている。
- [x] 1万ページの合成データで計測し、`SPEC.md` の目標に収まることを確かめる。完了条件: 計測結果を `docs/perf.md` に書く
  - `npm run perf`（Node.js）と `npm run perf:e2e`（Chromium、`perf/.data` に1万ファイルを書き出す）。2回目の起動が約2秒で目標の100msに収まらなかったので、`DECISIONS.md` に「起動時は解析結果だけを読む」を書き、次のタスクにした。検索も本文の走査で170〜200msかかる。
  - 解析は塗りつぶしを1回にして6.4秒→1.1〜2.0秒になった。ローカルモードの一覧は1万ファイルを同時に開くと `EMFILE` になるので64件ずつにした。
- [x] 起動時に解析結果だけを控えから読む（`DECISIONS.md` 2026-09-27「起動時は解析結果だけを読む」）。全ページの解析結果（`sha` を含む）を一つのレコードとして IndexedDB に置き、控えから索引を作って先に表示し、差分はその後に取って `set`/`remove` で索引に反映する。差分の比較はレコードの `sha` と行う。解析の版が違えば控えの中身から全件を解析し直す。完了条件: 単体テストで、2回目の起動が本文を読まずに索引を作ること、差分で差し替えたページだけ解析し直すこと、レコードが古ければそのページを読み直すこと、版が違えば控えから全件解析し直すことを確かめる。`npm run perf:e2e` で「控えを開いてから `name`・`title` で引ける索引ができるまで」が100ms以内になり、逆引きの構築と差分の取得の時間も分けて `docs/perf.md` に追記する
  - `src/client/kb.ts` の `Kb`。`Kb.open(store)` → 描画 → `kb.prepareBacklinks()` → `kb.sync(source)` の順で使う。`open` は中央値61ms。リンクはレコードから分けて置き（`store.getLinks`）、`prepareBacklinks` と `sync` の中で読む。バックリンクと 2 hop link は `kb.backlinks(ref)`・`kb.twoHop(ref)`（async。読み終わるのを待つ）を使い、`kb.index` の逆引きを直接呼ばない。
  - 本文は `kb.page(ref)` でそのページの分だけ読む（1〜3ms）。検索用に全件読むと0.9秒かかるので、段階3では最初の検索のときに読む。`sync.ts` は `source.ts`（取り込み元）に名前を変えた。

## 段階3 表示と検索

- [x] `/p/<name>` でページを表示する。marked、Mermaid、`[[リンク]]`、`#タグ`、作成日・更新日、まだないページ、`.md` リンクの転送。完了条件: e2eで見本ページが表示され、リンクをクリックして遷移できる
  - `src/client/render.ts`（marked の `walkTokens` で文章のトークンの中だけ `[[ ]]`・`#` を `<a>` に置き換える。コード・HTML・リンクの表示名・画像の代替文には触れない。表の行は `|` を先に `\|` にする。相対パスは `resolveHref`）、`router.ts`（`parseRoute`、`/` で始まるリンクのクリックを横取り）、`view.ts`（`showPage`、`showList`、描画の通し番号 `beginRender`）。marked と mermaid を入れた（`DECISIONS.md`）。Mermaid は図のあるページで動的 import する。段階4のマクロ展開も、本文の文字列ではなくトークンに対して行うほうがよい。
  - 表示名に HTML のタグや強調の記号を含む `[[x|<i>y</i>]]` は marked が先に分けるのでリンクにならない（索引には入る）。差分を取り終えたあとの描き直しは、変わったものがあるときだけ行う（段階5の編集中に描き直さないため）。
  - `/` はまだ仮の一覧のまま。`settings` のタスクで今日の日付ページにする。まだないページの見出しの下のバックリンクは次のタスク。
- [x] バックリンクと2 hop linkをページ末尾に出す。完了条件: e2eで見本ページの末尾に期待どおりのリンクが出る
  - `view.ts` の `appendRelated`。本文を先に出してから `kb.backlinks`/`kb.twoHop`（async。初回は逆引きの構築を待つ）で末尾に足す。バックリンクはないときも「なし」と見出しを出し、2 hop link はあるときだけ出す。
- [x] 検索欄（固定、AND、IME対応）と `/all`。完了条件: e2eで検索語を入力すると結果が差し替わり、`/all?q=` に残る
  - `src/client/search.ts` の `search(pages, query, bodyOf)`。本文は `kb.bodies()`（小文字にした全ページの本文。最初の検索で控えから全件読み、差分で更新）。読み終わるまではタイトルだけで探し、読めたら描き直す。検索欄は `main.ts` にあり、`/all` にいるあいだは `replaceState` で履歴を積まない。IME は `compositionstart`/`compositionend` と `isComposing` で見る。
  - 1万ページの全文の走査は170〜200ms（`docs/perf.md`）で目標の100msを超える。体感で気になったら「完成後」の trigram 索引を前に出す。
- [x] `settings` ページの読み取り（トップ、ヘッダー、`style.css`）と `/` の振り分け。完了条件: e2eで `/` が今日の日付ページになり、ヘッダーのリンクが `settings` の内容になる
  - `src/client/settings.ts`（`parseSettings`）と `md.ts`（`section`・`codeBlock`・`listItems`。段階4の `kb.section`/`kb.codeBlock` の本体）。`kb.settings()` は `resolve("settings")` で name か H1 が settings のページを読む。`/` は `router.replace` で `/p/<name>` に差し替える。「トップ」に `{{ }}` が残っていれば（マクロは段階4）指定なしとみなして今日の日付ページにする。差分で何か変わったら settings を読み直す。
  - `/` が一覧でなくなったので、e2e の smoke と sync、`perf/startup.perf.spec.ts` は `/all` を開く。

## 段階4 マクロ

- [x] `{{名前 引数}}` の展開（コード内は除外、未登録は残す）と、`settings` の `script.js` のブラウザでの実行、`kb` API。完了条件: `fixtures/` の `settings` に定義したマクロが表示で展開される単体テストとe2eが通る
  - マクロの関数は Promise を返してよく、本文は `kb.page(ref)` で読む（`DECISIONS.md` 2026-09-27）。見本の `embed` は `async` に書き換えた。`src/client/macro.ts`（`expand`）と `scripting.ts`（`Scripting`。`new Function` で `script.js` を実行し、`kb.macro`/`kb.command` の登録と構文エラー・実行時エラーを `error` に持つ）。`showPage` は本文を展開してから HTML にする。`/` のトップも展開してから最初のリンクを取る。
  - 展開は1回きり（戻り値の中の `{{ }}` は展開しない）。入れ子にしたいマクロは `kb.expand` を自分で呼ぶ（見本の `embed` がそう）。マクロが例外を投げたら、その場所に `（{{名前}}: 理由）` を出す。
- [x] スクリプトの構文エラーを `settings` ページの先頭に出す。完了条件: e2eで壊れたスクリプトを保存するとエラーが表示される
  - `showPage` が `scripting.error` と `scripting.settingsName` を見て、settings ページの先頭に `.script-error` を出す。`new Function` の SyntaxError には行番号が入らない（V8）ので、名前と理由だけ。読み込み時の実行時エラーも同じ場所に出し、例外の前に登録されたマクロは残る。
  - 見本の `touched` は `kb.pages` の順（控えの順。Linux では `readdir` が名前順でない）に依存しないよう、名前で並べる。
  - ファイルを書き換える e2e は `e2e/mutating/` に置く。Playwright の `mutating` プロジェクトで、`fixtures/` を `e2e/.data` に写した別のサーバー（ポート5197）を使って順に動かす（`e2e/global-setup.ts`）。保存は段階5なので、いまは `request.put` で書き換えている。段階5で保存ができたら、エディタから保存する形に書き換える。

## 段階5 編集と保存

- [x] CodeMirror 6でページをその場で編集する。完了条件: e2eで本文を書き換えると表示に反映される
  - `src/client/editor.ts`（動的 import。`minimalSetup` に括弧の補完と Markdown のキー操作を足したもの）と `view.ts` の `startEdit`。「編集」で `.body` をエディタに差し替え、「表示」で描き直す。編集するのはファイルの中身そのもの（`kb.content(path)`）。下書きは `src/client/drafts.ts`（path → 基準のファイルと今の中身。改行は LF にそろえる）に持ち、表示はそれを解析して出す。保存は次のタスク。索引（title・links）は保存で更新する。
  - 保存のタスクで足すもの: `Kb.put(file)`（控え・索引・解析結果に1ページを反映）、`Source.write(path, content, sha, message)`、`leavePage()` からの保存、`pagehide` での保存（失敗に備えて下書きを IndexedDB にも置くことを検討）、入力停止の判定は IME の変換中を待つ。
- [x] 保存のタイミング（入力停止・ページ移動・タブを閉じる）と、ローカルモードでの書き込み。`updated` の更新。完了条件: e2eで編集後にファイルが変わっている
  - `src/client/saver.ts` の `Saver`。下書きの変更で30秒のタイマーを張り直し、`render` のたび（ページ移動）と `pagehide`・`visibilitychange`（`keepalive` の fetch）で `flush`。`Source.write` → `Kb.put`（控え・索引・解析結果に反映）→ 下書きの基準を新しい sha に。失敗したら下書きを残し、ヘッダーに理由を出して次の機会に送り直す。`updated` は `withUpdated`（front matter のないページには足さない。`DECISIONS.md`）。
  - ローカルモードの PUT はまだ `sha` を比べない（次の競合のタスク）。
  - 編集する e2e はページを離れるだけで保存が走り `fixtures/` を書き換えるので、必ず `e2e/mutating/` に置く（`edit.spec.ts` もそちらへ移した）。書き戻しは `helpers.ts` の `putFile`（いまの sha を取ってから PUT）。
  - `Kb.put` は保存のたびに解析結果のレコード全体（1万ページで数MB）を書く。入力中に引っかかるようなら、`requestIdleCallback` か次の `sync` までまとめる。未計測。IME の変換中に30秒切れると未確定の文字を含む中間状態が1コミットになる（データは失われない）。
- [x] 新しいページの作成（ファイル名は時刻、`KB_DIR` の直下）。完了条件: e2eでまだないページに書き込むとファイルができる
  - `GET /api/pages` に `dir` を足し（`DECISIONS.md`）、`Source.dir()` で取る。まだないページの「編集」で `view.ts` の `newPageFile`（日付ページは `YYYY-MM-DD.md`、それ以外は時刻のファイル名に `# 名前`）の下書きを `openNewDraft` で作り、保存は `sha: null` で送る。保存後は title（日付ページは name）で解決される。何も書かずに離れれば保存しない。
  - 「編集」は起動後の差分の同期が成功してから出す（索引が古いまま既存のページを新しく作らないため）。段階7の `/new`（タイトルなし）では `newPageFile` の見出しを省く形にし、ファイル名を鍵に `openNewDraft` して `/p/<ファイル名>` に差し替える。
- [x] 競合の検出（SHA不一致で上書きしない）。完了条件: 単体テストで、裏で変えたファイルへの保存が拒否され、両方の内容が返る
  - ローカルモードの PUT は sha を比べ、違えば 409 で `{ error, current }`（相手の内容）。`sha: null` は新規のみ（`DECISIONS.md`）。`ApiSource.write` は `ConflictError`、`Saver` は下書きに相手の内容を付けて自動の再送から外し、控えと索引を相手の内容にする。ページの先頭に `section.conflict`（相手の内容と「上書き」「そろえる」）。段階6の Worker は GitHub の 409/422 を同じ形に写す。

## 段階6 GitHub中継

- [x] Workerの `/api/*` をGitHub Contents API・tarball・compare で実装する。完了条件: GitHub APIをモックした単体テストが通る
  - compare は使わず、Trees API の一覧の `sha` を控えと比べる（`DECISIONS.md`）。`src/worker/github.ts`（GitHub の包み）と `api.ts`（`/api/pages`・`/api/pages/<path>`・`/api/files/<path>`・`/api/archive`）。GitHub の 409/422/404 は、いまの中身を GET して `{ error, current }` の 409 に写す。正しい sha でも 409 なら一度だけ試し直す。ドットで始まる区切りは 400（ローカルモードも。`src/shared/api-path.ts` で共有）。
  - `GET /api/pages` に `head`、`/api/archive` に `x-head`（ブランチの先頭のコミット）。次のタスクで、ブラウザが tarball を展開して `blobShaOf` で sha を計算し、一覧と突き合わせる。
- [x] ブラウザの初回読み込み（tarball）と差分更新（compare）をWorker経由でつなぐ。完了条件: モックで、初回は全件、2回目は差分だけ読むテストが通る
  - compare は使わず、tarball の各ファイルの sha を計算して一覧と突き合わせる。`head` は比べず、一覧に `head` があるかで tarball の有無を見る。控えが空か読み直しが300件を超えるときに tarball を使う（`DECISIONS.md` 2026-09-28）。`src/client/tar.ts`（自前の tar の読み手）、`ApiSource.archive`、`Kb.sync`。通しのテストは `source.test.ts` の「Worker 経由の取り込み」。
  - ローカルモードは1件ずつのまま。tarball の経路は `e2e/archive.spec.ts` で `page.route` を使って Chromium で通している。手元の `git archive`（git 2.53.0）の出力は読めて sha も合い、`eol=crlf` は CRLF に変換されることを確かめた（`src/client/testdata/git-archive.tar.gz`。CRLF は LF に戻して突き合わせる）。1件ずつ読むものが300件を超えると、起動ごとに300件ずつ読んで進む。
  - 次のタスクで確かめるのは、GitHub の tarball が同じ形か、知識庫リポジトリに `export-subst`・`ident`・Git LFS の指定があるか、添付ファイルの量の三つ。
- [x] 本番へデプロイして、Accessを通って自分のknowledgeを開けることを確かめる。完了条件: 人が確認する（ここで止まって報告する）
  - 2026-09-28 に人が確認した。PR #20 のマージ後の本番で Access を通って知識庫が開け、`/api/pages/<path>` が大量に出ることはなかった。GitHub の tarball も手元の `git archive` と同じく読めて sha が一覧と合っている（推測。1件ずつ読み直した件数は数えていない）。知識庫リポジトリに `.gitattributes`・Git LFS・大きな添付ファイルはなく、前のタスクの補足にある `export-subst`・`ident`・LFS の指定と添付ファイルの量は気にしなくてよい。
  - アクセスのたびに `/favicon.ico` へのリクエストが出ていたので、`index.html` に `<link rel="icon" href="data:,">` を足して止めた。アイコンは「完成後」の PWA のタスクで用意する。

## 段階7 取り込み

- [x] `/new?title=&body=` と `/append?page=&body=`。完了条件: e2eで両方のURLからページが作られる・追記される
  - `src/client/capture.ts`（行き先の判定 `planCapture`、追記の `appendBody`、注意の `captureWarnings`、確認画面 `showCapture`）。確認画面で「保存」を押すまで書かず、差分の同期（`whenSynced`）を待ってから押せる。保存は `Saver.saveNow` で、失敗したら下書きを戻す。`/new` の title が既存のページなら追記にする（`DECISIONS.md`）。
  - URL の長さの上限と、Access のログインを挟んだときにクエリが残るかは未確認。次の README のタスクで、人が長い本文のブックマークレットで確かめる。
  - 保存の前に本人の確認（内容を見せて「保存」を押す）を挟む。リンクを踏むだけで任意の本文が保存されて表示されると、消毒をしていない表示（`DECISIONS.md` 2026-09-27「marked と mermaid を入れる」）と合わせて、細工したリンクから知識庫を読み書きされる。
- [ ] `README.md` にブックマークレットの例と、Cloudflare側の設定手順を書く。完了条件: 人が読んで手順どおりに設定できる
  - README は書いた。完了条件は人の確認なので、チェックは人待ちの README の項目が済んでから入れる。3つのブックマークレットは Node.js で生成される URL と本文を確かめ、ローカルモードで確認画面が出るところまで見た（保存は押していない）。

## 完成後

- [ ] PWAのマニフェストと `share_target`
- [ ] `kb.command` の呼び出し方（右クリックか `/名前`）を決めて実装する
- [ ] ページアイコン `[[名前.icon]]`
- [ ] 全文検索が遅くなったらtrigram索引
- [ ] バックリンクと2 hop linkの件数の上限。共通のタグ（`#要約待ち` など）を持つページが多いと、2 hop link の1グループに数百件並ぶ。グループごとの上限か `<details>` で畳むかを `DECISIONS.md` に書いてから
