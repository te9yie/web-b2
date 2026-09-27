# web-b2

Markdownファイルのリポジトリ（知識庫）をブラウザから閲覧・検索・編集するWebアプリ。Cloudflare Workers上で動き、ファイルはGitHubのリポジトリに置く。`[[リンク]]` で書いてつなぐ操作を軽くし、それ以外の機能は `settings` ページのスクリプトで組み立てる。

- 仕様は [SPEC.md](SPEC.md)
- 作業の順番は [TODO.md](TODO.md)
- 決めたことと理由は [DECISIONS.md](DECISIONS.md)
- 作業のルールは [AGENTS.md](AGENTS.md)

まだ雛形の段階で、画面にはアプリ名と今日の日付しか出ない。

## 手元で動かす

```bash
npm install
KB_ROOT=fixtures npm run dev:local
```

`fixtures/` には見本のノートが入っている。テストは `npm test`（単体）と `npm run e2e`（ブラウザ、初回は `npx playwright install chromium` が要る）で回す。自分の知識庫を読むときは `KB_ROOT` にそのディレクトリを指定する。
