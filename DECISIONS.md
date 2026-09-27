# 決めたことと理由

新しいものを上に足す。`SPEC.md` を変えるときは先にここに書く。

## 2026-09-27 Workerの設定値はすべてダッシュボードの Secret にする

このリポジトリは公開なので、wrangler 設定に書いた vars は誰でも読める。知識庫のリポジトリ名も出したくないので、トークン以外も Secret にする。wrangler 設定には vars を書かない。

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
