# web-b2

Markdownファイルのリポジトリ（知識庫）をブラウザから閲覧・検索・編集するWebアプリ。Cloudflare Workers上で動き、ファイルはGitHubのリポジトリに置く。`[[リンク]]` で書いてつなぐ操作を軽くし、それ以外の機能は `settings` ページのスクリプトで組み立てる。

- 仕様は [SPEC.md](SPEC.md)
- 作業の順番は [TODO.md](TODO.md)
- 決めたことと理由は [DECISIONS.md](DECISIONS.md)
- 作業のルールは [AGENTS.md](AGENTS.md)

## 手元で動かす

```bash
npm install
npm run dev:local
```

`http://localhost:5173` で開く（ポートは `npm run dev:local -- --port 5199` のように変えられる）。ローカルモードでは、Node.js のサーバーが `KB_ROOT`（既定 `fixtures`）の下の `KB_DIR`（既定 `notes`）を直接読み書きし、Worker と同じ `/api/*` を返す。認証はないので、`--host` を付けて他の端末から開けるようにしない。

自分の知識庫を読むときは、`KB_ROOT` にリポジトリを置いたディレクトリを指定する。保存するとそのファイルを直接書き換える（コミットはしない）。`fixtures/` を書き換えずに試したいときは、別の場所に写してからそこを指定する。

```bash
cp -r fixtures /tmp/kb
KB_ROOT=/tmp/kb npm run dev:local
```

PowerShell では `$env:KB_ROOT = "C:\path\to\kb"; npm run dev:local` と書く。

テストは `npm test`（単体）と `npm run e2e`（ブラウザ、初回は `npx playwright install chromium` が要る）で回す。どちらも `fixtures/` を使い、GitHub や Cloudflare に接続しない。

## Cloudflare に置く

Worker は画面の静的ファイルと `/api/*` を配り、`/api/*` では GitHub API への中継だけをする。Worker 全体に Cloudflare Access をかけ、Cloudflare アカウントのメンバーだけが開けるようにする。静的ファイルを持つ Worker には Access の結果（`ctx.access`）が届かないので、Worker は Access が付ける `Cf-Access-Jwt-Assertion` の JWT を自分で検証する（`DECISIONS.md` 2026-09-27）。そのため Access のチームドメインと AUD も Worker に登録する。

以下の手順は上から順に行う。Access で保護されたことを確かめる前に GitHub のトークンを登録しない。

### 設定値はすべてシークレットで登録し、知識庫を指す値はプロダクションだけに入れる

このリポジトリは公開なので、`wrangler.jsonc` には設定値を書かない。ダッシュボードの Worker の「設定」タブ（Settings > Variables and Secrets）で、タイプを「シークレット」にして登録する。テキスト（平文の変数）で登録すると、デプロイのあとで消えて 401 になる。`wrangler deploy` はダッシュボードで設定した変数を上書きし、シークレットは消さない（https://developers.cloudflare.com/workers/wrangler/configuration/ 、取得日: 2026-09-28）。プロダクションのシークレットは登録しただけで本番に反映され、ビルドをやり直さなくてよい（2026-09-28 に確かめた）。

`ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` は、プロダクションと Previews Base の両方に登録する。`GITHUB_TOKEN` と `KB_REPO`（登録するなら `KB_BRANCH` と `KB_DIR` も）はプロダクションだけに登録する。プレビューは PR のブランチごとにビルドされ、マージ前のコードで動く。Previews Base に本番のトークンと知識庫を入れると、プレビューから本番の知識庫を読み書きし、PR のプレビューで保存した内容も本番の知識庫にコミットされる。Previews Base に入れなければ、プレビューの `/api/*` は 500（`KB_REPO か GITHUB_TOKEN が設定されていない`）を返し、知識庫には届かない。

プレビューで読み書きまで試したいときは、試し用のリポジトリを作り、Previews Base にその `KB_REPO` と、そのリポジトリだけに権限を絞ったトークンを `GITHUB_TOKEN` として登録する（手順4の4）。

Previews Base のシークレットは、登録した後に作られたプレビュー（新しいブランチの最初の push）にしか入らない。登録前からあるブランチのプレビューで確かめたいときは、新しいブランチを push する。

| 名前 | 登録先 | 要るか | 中身 |
| --- | --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | プロダクションと Previews Base | 要る | `https://<チーム名>.cloudflareaccess.com`。`https://` と末尾の `/` はなくても通る |
| `ACCESS_AUD` | プロダクションと Previews Base | 要る | Access のアプリの AUD タグ |
| `GITHUB_TOKEN` | プロダクションだけ。プレビューで試すなら Previews Base に試し用 | 要る | 知識庫のリポジトリの Contents だけを読み書きできる fine-grained token |
| `KB_REPO` | プロダクションだけ。プレビューで試すなら Previews Base に試し用 | 要る | `owner/repo` |
| `KB_BRANCH` | `KB_REPO` と同じ | 既定なら不要 | 読み書きするブランチ。既定 `main` |
| `KB_DIR` | `KB_REPO` と同じ | 既定なら不要 | ページを置くディレクトリ。既定 `notes`。先頭と末尾に `/` を付けない。空にすると既定の `notes` になるので、リポジトリの直下は指定できない |

### 1. Workers Builds にリポジトリをつなぎ、Access で保護する

1. Cloudflare のダッシュボードの Workers & Pages で、このリポジトリ（を fork したもの）をインポートする。
2. プロジェクト名は `web-b2` にする。Workers Builds では、ダッシュボードの Worker 名と `wrangler.jsonc` の `name` を一致させる必要がある（https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/ 、取得日: 2026-09-28）。別の名前にするなら `wrangler.jsonc` の `name` も直す。
3. ビルドコマンドは `npm run build`、デプロイコマンドは `npx wrangler deploy`（既定のまま）、本番ブランチは `main`、プレビュービルドは有効にする。`wrangler.jsonc` の `"previews": {}` はプレビューのビルドに要るので消さない。
4. 「Protect with Cloudflare Access」をオンにし、ポリシーは Cloudflare account members にする。
5. 最初のビルドとデプロイが成功することを確かめる。

### 2. Worker URL を有効にし、ログイン画面が出ることを確かめる

1. Worker の「Access」タブで、Worker Access が「すべてのトラフィック」（本番とプレビュー）になっていて、ポリシーが Cloudflare account members の許可になっていることを確かめる。
2. 「ドメイン」タブの Worker URL で、プロダクション（`web-b2.<サブドメイン>.workers.dev`）のスイッチをオンにする。PR ごとのプレビューも開きたければプレビューもオンにする。どちらも Access の対象になる。
3. シークレットウィンドウで `https://web-b2.<サブドメイン>.workers.dev/` を開く。Cloudflare のログイン画面に転送されれば Access がかかっている。転送されずに画面が開いたら、ここで止めて手順1と2の Access の設定を見直す。
4. 転送先のアドレスバーの URL を控えておく。ホスト名がチームドメイン（`<チーム名>.cloudflareaccess.com`）で、クエリの `kid=` の値が AUD になる。

Access がかかっていなくても、Worker は JWT のないリクエストを 401 にするので `/api/*` から知識庫は読めない。ただしそのままでは画面から先へ進めないので、Access を直してから次へ進む。

### 3. Access のチームドメインと AUD を登録する

「設定」タブで、プロダクションと Previews Base の両方に `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` をシークレットで登録する。AUD は次のどれかで分かる。上から順に試す。

- 手順2で控えた転送先 URL の `kid=` の値。
- Zero Trust の Access > Applications でこの Worker のアプリを開いたときの「Application Audience (AUD) Tag」。one-click Access のアプリがこの一覧に並ぶかは未確認。
- ログインした後、開発者ツールの Application > Cookies で `CF_Authorization` の値（JWT）をコピーし、コンソールで次を実行する。`iss` がチームドメイン、`aud` が AUD になる。

  ```js
  const t = "ここに CF_Authorization の値を貼る";
  const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  console.log(p.iss, p.aud);
  ```

登録したら、ログインしたブラウザで `https://web-b2.<サブドメイン>.workers.dev/api/pages` を開く。`{"error":"KB_REPO か GITHUB_TOKEN が設定されていない"}` が出れば Access の検証は通っている。`{"error":"Accessを通っていない"}` のままなら、値の打ち間違いか、登録前に作られたプレビューを開いている。401 のあいだはトークンを登録しない。本番ではシークレットを登録しただけで反映されるので、ビルドをやり直さずに開き直せばよい。

### 4. GitHub のトークンを作り、知識庫のリポジトリを登録する

1. GitHub の Settings > Developer settings > Personal access tokens > Fine-grained tokens でトークンを作る。知識庫のリポジトリが組織のものなら、Resource owner をその組織にする（自分のままだと組織のリポジトリを選べない）。Repository access は「Only select repositories」にして知識庫のリポジトリだけを選び、Repository permissions は Contents を Read and write にする（Metadata の Read-only は自動で付く）。ほかの権限は付けない。
2. 期限の日を控える。切れると `/api/*` が 502 になる。
3. 「設定」タブで、プロダクションだけに `GITHUB_TOKEN` と `KB_REPO` をシークレットで登録する。ブランチが `main` でなければ `KB_BRANCH` を、ページの置き場が `notes` でなければ `KB_DIR` も登録する。Previews Base には登録しない（プレビューから本番の知識庫を読み書きしないため）。
4. プレビューでも読み書きを試したいときだけ、試し用のリポジトリを作り、1 と同じ手順でそのリポジトリだけを選んだトークンを別に作る。Previews Base に、そのトークンを `GITHUB_TOKEN`、試し用のリポジトリを `KB_REPO` として登録する。本番のトークンは使い回さない。試し用のリポジトリは README などを付けて作り、`main` にコミットを1つ以上置く（空のリポジトリにはブランチがなく、ブランチの取得で 502 になる見込み。推測）。Previews Base に `KB_BRANCH`・`KB_DIR` を登録しなければ、ブランチとページの置き場は既定の `main` と `notes` になり、本番の値は使われない。`notes/` に `.md` がないうちは `pages` が空になる。

前の手順（プロダクションと Previews Base の両方に登録する）で Previews Base にも `GITHUB_TOKEN` と `KB_REPO` を入れていたら、Previews Base から消す。作成済みのプレビューには消した後も残る見込み（未確認）なので、本番のトークンを GitHub で作り直してプロダクションだけに登録し直し、古いトークンを GitHub で削除する。

知識庫のブランチに保護ルール（PR を必須にするなど）があると、書き込みは失敗する（推測。そのときの応答は未確認）。

### 5. 開いて確かめる

本番の Worker URL（`https://web-b2.<サブドメイン>.workers.dev`）で確かめる。

1. `/api/pages` を開き、`{"pages":[{"path":"notes/...","sha":"..."}, ...],"dir":"notes","head":"..."}` の形の JSON が出ることを確かめる。`pages` が空なら `KB_DIR` を見直す。
2. `/` を開く。初回は知識庫全体の tarball を取り込むので数秒かかる。今日の日付のページ（`settings` ページの「トップ」を書いていればそのページ）が開けば、読み込みは通っている。
3. どれかのページを「編集」で書き換えて、別のページに移る。知識庫のリポジトリに `web: <ページのタイトル>` のコミットができていれば、書き込みも通っている。

### うまくいかないとき

`/` か `/api/pages` を開いたときに出るもので見分ける。このアプリで確かめたのは Access の 401 だけで、502 の行はどれも GitHub の一般的な応答から考えたもの。プレビューで出たときは、`GITHUB_TOKEN`・`KB_REPO`・`KB_BRANCH`・`KB_DIR` を Previews Base の値（試し用のリポジトリとトークン。`KB_BRANCH`・`KB_DIR` は、登録していなければ既定の `main` と `notes`）に読み替える。

| 見えるもの | 考えられる原因 |
| --- | --- |
| ログイン画面が出ずに画面が開く | Access がかかっていない。手順1と2の Access の設定を見直す |
| 401 `Accessを通っていない` | ログイン画面を経ずに開けたなら、Access がかかっていない（1行目と同じ）。ログインした後なら、`ACCESS_TEAM_DOMAIN` か `ACCESS_AUD` がないか違う。プレビューなら、Previews Base に登録する前に作られたプレビューを開いている（新しいブランチを push する）。テキストの変数で登録していたら、シークレットで登録し直す |
| 500 `KB_REPO か GITHUB_TOKEN が設定されていない` | 本番なら、プロダクションに手順4の登録がない。プレビューなら、Previews Base に試し用を登録していない（手順4の4をしていなければこう出る）。試し用を登録したなら、登録する前に作られたプレビューを開いている（新しいブランチを push する） |
| 502 `GitHub: ブランチの取得が 401` | トークンの打ち間違いか期限切れ |
| 502 `GitHub: ブランチの取得が 403` | トークンの権限が足りない。組織のリポジトリなら、組織が fine-grained token を許可していない |
| 502 `GitHub: ブランチの取得が 404` | `KB_REPO` の打ち間違い、トークンの対象にそのリポジトリが入っていない、`KB_BRANCH` のブランチがない、のどれか |
| 502 `GitHub: ツリーが大きすぎて一覧を取り切れない` | リポジトリのファイルが多すぎて、GitHub の Trees API が一覧を切り詰めた |
| `pages` が空 | `KB_DIR` が違う。先頭か末尾に `/` を付けていないか。プレビューの試し用のリポジトリなら、`KB_DIR`（既定 `notes`）に `.md` がまだない |

### トークンの期限が切れたとき、設定値を変えたとき

新しいトークンを作り、プロダクションの `GITHUB_TOKEN` を登録し直す。Previews Base に試し用のトークンを入れているなら、そちらは別のトークンで期限も別なので、切れたら試し用のリポジトリだけを選んで作り直し、Previews Base で登録し直す。`ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` を変えるときは両方で直す。`KB_REPO`・`KB_BRANCH`・`KB_DIR` を変えるときはプロダクションで直す（試し用を入れていれば、Previews Base のほうは試し用の値のまま）。プロダクションのシークレットは、登録したときと同じくビルドなしで反映される見込み（登録し直したときは未確認）。Previews Base の変更は作成済みのプレビューには入らないので、プレビューで確かめるときは新しいブランチを push する。

## ブックマークレットで取り込む

`/new?title=&body=` は新しいページを作り、`/append?page=&body=` は決まったページの末尾に足す。どちらも開いただけでは書かず、行き先と本文の確認画面が出て、「保存」を押したときに書く。本文は確認画面で直せる。`/new` の `title` が既存のページ（ファイル名か見出し）に当たるなら、新しいページを作らずそのページの末尾に足す。まだないページへの `/append` はページを作る（`YYYY-MM-DD` の形ならファイル名も日付になる）。

確認画面の「保存」は、起動後の差分の同期が済み、ページが前に出てから500ms経つまで押せない。初めて開く端末では、知識庫全体の取り込みが終わるまで待つ。下の例は、取り込み元のページを残すために新しいタブで開く。確認画面は別のサイトの枠（iframe）の中では「保存」を出さないので、取り込み元のページの中に枠で確認画面を出す作りにはできない。

新しいページを作るとき、`title` や `page` を見出しにすると HTML かリンクになる文字（`Vec<T>` の `<T` や `](` など）がある場合と、見出しから読み直すと別の文字になる場合（`Episode #` の末尾の ` #` は見出しの閉じの記号として落ちる）は、確認画面にタイトルを直す欄が出る。直すと保存できる。既存のページに足すときは見出しを書かないので、この欄は出ない。本文に HTML に見える文字（`<T` など）があるときは注意が出るが、保存は止めない。

### ブックマークレットの入れ方

PC の Chrome では、ブックマークバーで右クリックして「ページを追加」を選び、名前を付けて、URL 欄に下の例の「貼る1行」をそのまま貼る。`https://web-b2.<サブドメイン>.workers.dev` は自分の Worker URL に書き換える。ローカルモードで試すなら `http://localhost:5173` にする。使うときは、取り込みたいページで必要なら文を選択してから、そのブックマークを押す。

コードを直すときの注意が二つある。URL 欄に貼ると改行が消えるので、`//` のコメントを書かない（以後が全部コメントになる）。`javascript:` の URL は実行の前に `%` と16進2桁の並びがデコードされるので、コードの中に `%28` のような並びを直に書かない（例の `'%'+c.charCodeAt(0).toString(16)` はそのためにこう書いている）。

Android の Chrome では、PC の Chrome と同期していれば PC で作ったブックマークがそのまま入る。Android で作るときは、何かのページをブックマークしてから、ブックマークの編集で URL 欄にコードを貼る。ブックマークの一覧から押しても動かず、アドレスバーにブックマークの名前を打って候補に出たものを押すと動く（未確認。`TODO.md` の完成後で確かめる）。打ちやすい名前（`kbnew`、`kbtoday` など）にしておく。`window.open` で新しいタブが開くか、選択範囲が残るかも未確認。新しいタブが開かなければ、コードの最後の `window.open(u,'_blank','noopener')` を `location.href=u` に替える（同じタブで開き、取り込み元のページからは離れる）。

コードの中に日本語（`(以下略)`、`あとで読む`）を直に書いたブックマークレットが Chrome で動くかは未確認。動かなければ `'\u3042\u3068\u3067\u8aad\u3080'` のように `\u` で書く。サイトによってはブックマークレットが動かないことがある（取り込み元のページの設定によるものと推測）。

Android の共有メニューからの取り込み（`share_target`）はまだない。

### 見ているページを新しいページにする（/new）

ページのタイトルを `title` にし、本文には URL と、選択範囲があればその引用（`> `）を入れる。

貼る1行:

```text
javascript:(()=>{const B='https://web-b2.<サブドメイン>.workers.dev',M=6000;const w=s=>s.toWellFormed?s.toWellFormed():s;let s=w(String(getSelection()).trim()),q='',n=0;for(const c of s){const e=c==='\n'?'\n> ':c;n+=encodeURIComponent(e).length;if(n>M){q+='\n> (以下略)';break}q+=e}const b=location.href+(q?'\n\n> '+q:'');const u=B+'/new?title='+encodeURIComponent(w(document.title))+'&body='+encodeURIComponent(b);window.open(u,'_blank','noopener')})();
```

読むための形（貼るのは上の1行）:

```js
(() => {
  const B = 'https://web-b2.<サブドメイン>.workers.dev';
  const M = 6000; // 選択範囲を encodeURIComponent した後の長さの上限
  // 対になっていないサロゲートがあると encodeURIComponent が例外を投げるので置き換える
  const w = (s) => (s.toWellFormed ? s.toWellFormed() : s);
  let s = w(String(getSelection()).trim()), q = '', n = 0;
  // 文字（コードポイント）ごとに、引用の形（改行は「改行と > 」）にしてから数え、上限を超えたらそこで切る
  for (const c of s) {
    const e = c === '\n' ? '\n> ' : c;
    n += encodeURIComponent(e).length;
    if (n > M) { q += '\n> (以下略)'; break; }
    q += e;
  }
  const b = location.href + (q ? '\n\n> ' + q : '');
  const u = B + '/new?title=' + encodeURIComponent(w(document.title)) + '&body=' + encodeURIComponent(b);
  window.open(u, '_blank', 'noopener');
})();
```

切るのは選択範囲だけで、長さは文字数ではなく、引用の `> ` を付けてエンコードした後の長さで数える。日本語は1文字が `%E3%81%82` の9文字になるので、6000 は日本語でおよそ660文字になる。短い行が続く選択範囲（箇条書きや表）では、行ごとに増える `%0A%3E%20` の分だけ入る文字が少なくなる。ページの URL とタイトルは数えていないので、その分だけ URL は 6000 文字より長くなる。タイトルの改行や続いた空白は確認画面の側で1つの空白にまとめる。同じ記事を二度取り込むと、2回目は同じ名前のページへの追記になる。

### 今日の日付ページに足す（/append）

今日の日付（ブラウザのタイムゾーンの `YYYY-MM-DD`）のページの末尾に `- [タイトル](URL)` を足す。日付ページがまだなければ `YYYY-MM-DD.md` で作られる。

貼る1行:

```text
javascript:(()=>{const B='https://web-b2.<サブドメイン>.workers.dev';const d=new Date(),z=x=>String(x).padStart(2,'0');const p=d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate());const t=(document.title||location.href).replace(/\s+/g,' ').replace(/[\\\[\]]/g,'\\$&');const h=location.href.replace(/[()]/g,c=>'%'+c.charCodeAt(0).toString(16));const u=B+'/append?page='+encodeURIComponent(p)+'&body='+encodeURIComponent('- ['+t+']('+h+')');window.open(u,'_blank','noopener')})();
```

読むための形:

```js
(() => {
  const B = 'https://web-b2.<サブドメイン>.workers.dev';
  const d = new Date(), z = (x) => String(x).padStart(2, '0');
  const p = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  // リンクの表示名。改行をまとめ、\ [ ] は Markdown のリンクを壊すので \ を付ける
  const t = (document.title || location.href).replace(/\s+/g, ' ').replace(/[\\\[\]]/g, '\\$&');
  // URL の ( ) はリンクの終わりと読まれるのでエンコードする（%28 と直に書くと実行前にデコードされる）
  const h = location.href.replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
  const u = B + '/append?page=' + encodeURIComponent(p) + '&body=' + encodeURIComponent('- [' + t + '](' + h + ')');
  window.open(u, '_blank', 'noopener');
})();
```

たとえばタイトルが `記事 [第1回]`、URL が `https://example.com/a_(b)?x=1` のページでは、本文は `- [記事 \[第1回\]](https://example.com/a_%28b%29?x=1)` になる。選択範囲も入れたければ、/new の例の切り詰めを持ってきて、`'\n\n> '` に続けて本文に足す。

### 決まったページに足す（/append）

日付の代わりに決まったページ名を `page` に入れる。例のページ名は「あとで読む」。まだなければ時刻のファイル名で作られ、1行目が `# あとで読む` になる。

貼る1行:

```text
javascript:(()=>{const B='https://web-b2.<サブドメイン>.workers.dev';const p='あとで読む';const t=(document.title||location.href).replace(/\s+/g,' ').replace(/[\\\[\]]/g,'\\$&');const h=location.href.replace(/[()]/g,c=>'%'+c.charCodeAt(0).toString(16));const u=B+'/append?page='+encodeURIComponent(p)+'&body='+encodeURIComponent('- ['+t+']('+h+')');window.open(u,'_blank','noopener')})();
```

読むための形は、今日の日付ページの例の `p` を `'あとで読む'` にしたもの。`page` に `settings` ページを指定すると、確認画面に注意が出る。

### 長い選択範囲と、ログインが切れているとき

URL の長さには Cloudflare 側の上限があり、値は未確認。上の /new の例は、引用の形にした選択範囲をエンコードした後の長さが 6000 文字を超えたら切って `(以下略)` を付ける。6000 は、上限を 16KB と見て、ログインを挟むと URL がもう一度エンコードされて長くなる分を見込んで置いた値で、根拠は推測。上限が分かったら `M` を直す。確認画面の本文の最後が `(以下略)` になっていたら、足りない分は保存した後にページを編集して足す。

Access のログインが切れているときにブックマークレットを押すと、ログイン画面を挟む。ログインの後に `title` と `body` が残って確認画面に出るかは未確認。確認画面の本文が空なら、一度アプリを開いてログインしてから、ブックマークレットを押し直す。
