# 決めたことと理由

新しいものを上に足す。`SPEC.md` を変えるときは先にここに書く。

## 2026-09-27 起動時は解析結果だけを読み、本文は表示と検索のときに読む

1万ページ・64MBの合成データで測ると（`docs/perf.md`）、2回目以降の起動は、IndexedDB から本文を読むのに0.6秒、解析と索引作りに1.3秒かかり、目標の100msに収まらなかった。一つ前の決定（索引は起動のたびに作り直す）を、この計測で改める。

IndexedDB には、ファイルの中身（`path`・`sha`・中身）に加えて、解析結果（`name`・`title`・`h1`・`created`・`updated`・`links`）を全ページ分まとめた一つのレコードとして置く。起動時はそのレコードだけを読んで索引を作り、本文は読まない。ページの表示ではそのページの本文だけを読み、検索では初めて検索したときに全件の本文を読んで以後は持っておく。差分更新で読み直したページは解析し直してレコードを書き換える。解析の直し方が変わったときのために、レコードに解析の版を入れ、版が違えば控えの中身から全件を解析し直す（取り直しはしない）。

## 2026-09-27 IndexedDBには索引ではなくファイルの中身を置き、索引は起動のたびに作り直す（同日の上の決定で改めた）

IndexedDBに保存するのは、ページごとの `path`・`sha`・中身そのものにする。索引（`name`→ページ、`title`→`name`、リンク先→リンク元）は保存せず、起動のたびに控えから解析して作る。

編集には front matter を含む元の文字列が要るので、中身はどのみち控えに置く。索引も置くと同じ情報を二重に持ち、Markdownの解析を直したときに古い索引を捨てる仕組みが別に要る。中身だけなら `sha` の比較で差分を取るだけでよい。1万ページの解析と索引作りが2回目以降の起動の目標（100ms）に収まらないと計測で分かったら、解析結果も控える形に変える。

## 2026-09-27 /api/* ではAccessのJWTをWorkerで検証する

`ctx.access` がないリクエストを401にするつもりだったが、静的ファイルを持つWorkerは内部のrouter Workerの後ろで動き、routerは `ctx.access` をこちらのWorkerに渡さない（https://developers.cloudflare.com/workers/configuration/cloudflare-access/ 、取得日: 2026-09-27）。一時的に入れた `/api/whoami` で本番のプレビューを確かめると、`ctx.access` はなく、`Cf-Access-Jwt-Assertion` ヘッダーと `CF_Authorization` クッキーは届いていた。

静的ファイルをWorkerで配ると静的アセットの無料・無制限の扱いから外れるので、Workerを分けずに、ヘッダーのJWTを自分で検証する。鍵はチームドメインの `/cdn-cgi/access/certs` から取り、RS256の署名、`aud`、`iss`、期限を確かめる。WebCryptoで書けるのでライブラリは足さない。チームドメインとAUDは、ほかの設定値と同じく Secret（`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`）にする。どちらかが未設定なら、確かめようがないので401にする。

## 2026-09-27 /api/* のパスはリポジトリのルートから、SHAはGitのblobのSHAにする

ページと添付ファイルのパスは、`KB_DIR` を含めたリポジトリのルートからのパス（`notes/a.md`）で渡す。添付ファイルは `KB_DIR` の外に置かれることもあり、ページの中の相対パスから解決した結果をそのままAPIに渡せる。GitHubのContents APIもリポジトリのルートからのパスを取るので、Workerで組み立て直さなくてよい。書き込めるのは `KB_DIR` の下の `.md` だけにする。

`sha` はGitのblobのSHA-1（`blob <バイト数>\0` と中身のSHA-1）にする。GitHubが返す値と同じで、ローカルモードでもファイルの中身から同じ値を計算できるので、競合の検出をどちらのモードでも同じ比較で行える。

## 2026-09-27 ローカルモードのAPIはViteの開発サーバーに載せる

ローカルモードの `/api/*` は、`Request` を受けて `Response` を返す関数として書き、Viteのプラグインで開発サーバーにつなぐ。SPAとAPIが同じポートに載るので、別のサーバーやプロキシの設定が要らず、e2eも `npm run dev:local` を起動するだけで動く。WorkerもRequest/Responseで書くので、テストの書き方をそろえられる。ライブラリは足さない。

## 2026-09-27 開発用に @types/node を入れる

`SPEC.md` の技術に挙げたもの（TypeScript、Vite、vitest、Playwright、wrangler）のほかに、`@types/node` だけを足す。Playwrightの設定で `process.env` を読むのと、ローカルモードのサーバーをNode.jsで書くのに型が要る。版は実行環境に合わせて22系にする。

## 2026-09-27 Workerの設定値はすべてダッシュボードの Secret にする

このリポジトリは公開なので、wrangler 設定に書いた vars は誰でも読める。知識庫のリポジトリ名も出したくないので、トークン以外も Secret にする。wrangler 設定には vars を書かない。

プレビューは本番の設定を引き継がないので、プロダクションと Previews Base の両方に登録する。Previews Base のシークレットは、登録した後に作られたプレビューにしか入らず、作成済みのプレビューは変わらない（https://developers.cloudflare.com/workers/previews/configuration/ 、取得日: 2026-09-27）。

## 2026-09-27 AccessはWorkerの one-click Access でかけ、アカウントのメンバーだけ許可する

Workersには、ダッシュボードから1つのWorkerにAccessをかける機能があり、routes・Custom Domains・workers.dev・プレビューをまとめて保護する。Accessを通ったリクエストには `ctx.access` が付き、JWTを自分で検証しなくてよい（https://developers.cloudflare.com/workers/configuration/cloudflare-access/ 、https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/ 、取得日: 2026-09-27）。Zero TrustでGitHubをIdPに登録してSelf-hostedアプリを作る手順が要らなくなる。使う人は自分だけなので、ポリシーは Cloudflare account members にする。プレビューも保護されるので、プレビュービルドは有効のままにする。

## 2026-09-27 索引とマクロはブラウザで動かす

Cloudflare Workersは `eval()` と `new Function` を許可しておらず（https://developers.cloudflare.com/workers/runtime-apis/web-standards/ 、取得日: 2026-09-27）、無料プランの1リクエストあたりCPU時間は10ms。`settings` のスクリプトの実行と全ページの索引はサーバーではできないので、ブラウザ側に置く。Workerは静的ファイルの配信とGitHub APIの中継だけにする。

## 2026-09-27 一つのWorkerで静的ファイルとAPIを配信する

Workersは静的ファイルとAPIを同じWorkerで扱え、静的ファイルへのリクエストは無料・無制限（https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ 、取得日: 2026-09-27）。PagesとWorkersを分けるより設定が少ない。

## 2026-09-27 デプロイはWorkers Builds、テストはGitHub Actions

Workers Buildsは無料プランでビルド3,000分/月、同時1、20分でタイムアウト（https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ 、取得日: 2026-09-27）。公開リポジトリならGitHub Actionsは無料（https://docs.github.com/en/billing/concepts/product-billing/github-actions 、取得日: 2026-09-27）。デプロイにActionsを使わないので、Actionsはテストだけに使う。

## 2026-09-27 索引はブラウザで作る

ブラウザがtarballを一度取得して索引を作り、IndexedDBに保存して以後は差分だけ取る。このリポジトリは公開なのでGitHub Actionsは無料で、Actionsで索引を作ることもできる。それでも最初はブラウザで作る。Actionsで作った索引を置く場所（KVかR2）とCloudflareのAPIトークン、知識庫のpushからこちらのワークフローを起動する仕組みが別に要り、検索と表示に全文が要る以上、ブラウザが受け取るデータの量も索引ファイルとtarballで変わらない。スマホで索引の作成が遅すぎると分かったら、Actionsで作ってR2に置く形に切り替える。
