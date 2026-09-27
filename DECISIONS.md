# 決めたことと理由

新しいものを上に足す。`SPEC.md` を変えるときは先にここに書く。

## 2026-09-27 索引とマクロはブラウザで動かす

Cloudflare Workersは `eval()` と `new Function` を許可しておらず（https://developers.cloudflare.com/workers/runtime-apis/web-standards/ 、取得日: 2026-09-27）、無料プランの1リクエストあたりCPU時間は10ms。`settings` のスクリプトの実行と全ページの索引はサーバーではできないので、ブラウザ側に置く。Workerは静的ファイルの配信とGitHub APIの中継だけにする。

## 2026-09-27 一つのWorkerで静的ファイルとAPIを配信する

Workersは静的ファイルとAPIを同じWorkerで扱え、静的ファイルへのリクエストは無料・無制限（https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ 、取得日: 2026-09-27）。PagesとWorkersを分けるより設定が少ない。

## 2026-09-27 デプロイはWorkers Builds、テストはGitHub Actions

Workers Buildsは無料プランでビルド3,000分/月、同時1、20分でタイムアウト（https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ 、取得日: 2026-09-27）。公開リポジトリならGitHub Actionsは無料（https://docs.github.com/en/billing/concepts/product-billing/github-actions 、取得日: 2026-09-27）。デプロイにActionsを使わないので、Actionsはテストだけに使う。

## 2026-09-27 索引はGitHub Actionsで作らない

非公開の知識庫リポジトリ側でActionsを回すと無料枠を消費する。代わりにブラウザがtarballを一度取得して索引を作り、IndexedDBに保存して差分だけ取る。

## 2026-09-27 Webから作るページの置き場所は環境変数にする

知識庫のどのディレクトリに新しいページを置くかはアプリでは決めず、`KB_WRITE_DIR`（既定 `notes`）で指定する。

## 2026-09-27 ログインはCloudflare Access、IdPはGitHub

アプリ側に認証を持たない。AccessのポリシーはメールアドレスでIncludeし、ログインの手段はGitHubアカウントにする。One-time PINは使わない。
