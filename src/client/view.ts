// 画面の描画。ページ（/p/<name>）と、一覧・検索結果（/all）
import type { Kb } from "./kb";
import { today } from "./date";
import { draftForNewPage, getDraft, isDirty, openDraft, openNewDraft, updateDraft } from "./drafts";
import { type Editor, createEditor } from "./editor";
import { type Page, type PageMeta, parsePage } from "./page";
import { escapeHtml, pageUrl, renderMarkdown } from "./render";
import type { Scripting } from "./scripting";
import type { SearchResult } from "./search";

export { escapeHtml };

// 描画の通し番号。描画を始めるたびに beginRender() で進め、await のあとに番号が変わっていたら古い描画を捨てる
let current = 0;
export function beginRender(): number {
  return ++current;
}
export function stale(seq: number): boolean {
  return seq !== current;
}

let mermaidReady = false;

// Mermaid は大きいので、図のあるページを初めて表示するときに読み込む
async function drawMermaid(root: HTMLElement, seq: number): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (nodes.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  if (stale(seq)) return;
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false });
    mermaidReady = true;
  }
  try {
    await mermaid.run({ nodes });
  } catch (e) {
    // 文法の誤りは mermaid が図の場所にメッセージを出す。ここでは記録だけ
    console.warn("Mermaid の描画に失敗", e);
  }
}

// 表示中のエディタと、そのページの path。ページを離れるときに破棄する
let editor: Editor | null = null;
let editingPath: string | null = null;

// エディタを開き始めてから閉じるまで。開き始め（動的 import の待ち）のあいだも含める。
// 差分の同期後の描き直しはこのあいだ行わない（開きかけのエディタが捨てられないように）
export function isEditing(): boolean {
  return editor !== null || editingPath !== null;
}

// エディタで開いているページの path。その下書きは片付けてはいけない
export function currentEditingPath(): string | null {
  return editingPath;
}

// ページを離れる（別のルートを描く）ときに呼ぶ。エディタを破棄する。保存は呼ぶ側（main.ts）が続けて行う
export function leavePage(): void {
  editor?.destroy();
  editor = null;
  editingPath = null;
}

// ページの表示。本文はマクロを展開してから HTML にする（ファイルは書いたまま）。
// 下書きがあれば、ファイルの中身の代わりに下書きを解析して表示する（sha は基準のもの）
// 新しいページを置くディレクトリ（KB_DIR）。main.ts が取り込み元から渡す
let pageDir: () => Promise<string> = async () => "";
export function setPageDir(provider: () => Promise<string>): void {
  pageDir = provider;
}

// 起動後の差分の同期が一度済んだか。済むまでは索引が古い（初回は空）ので、「まだないページ」に「編集」を出さない
// （既存のページを新しいページとして作ってしまわないように）
let synced = false;
export function markSynced(): void {
  synced = true;
}

function timestampName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// まだないページ name から書き始める新しいページの path と初期の中身（SPEC.md「新しいページ」）。
// name が日付ならファイル名も日付、それ以外は作成時刻。1行目は # name
export function newPageFile(name: string, dir: string, now: Date): { path: string; content: string } {
  const date = today(now);
  const file = /^\d{4}-\d{2}-\d{2}$/.test(name) ? name : timestampName(now);
  const path = dir === "" ? `${file}.md` : `${dir}/${file}.md`;
  return { path, content: `---\ncreated: ${date}\nupdated: ${date}\n---\n\n# ${name}\n\n` };
}

export async function showPage(kb: Kb, scripting: Scripting, name: string, root: HTMLElement, seq: number): Promise<void> {
  leavePage();
  await renderPage(kb, scripting, name, root, seq);
}

// showPage の本体。startNewPage からは編集中の印を保ったまま呼ぶ
async function renderPage(kb: Kb, scripting: Scripting, name: string, root: HTMLElement, seq: number): Promise<void> {
  let page = await kb.page(name);
  if (stale(seq)) return;
  // 変わっている下書きだけを優先する。保存できた（基準と同じ）下書きは、控えの中身（updated 済み）のほうが新しい。
  // まだないページは、その name から書き始めた新しいページの下書きを探す
  const draft = page ? getDraft(page.path) : draftForNewPage(name);
  // 新しいページの下書きは、まだ何も書いていなくてもページとして出す（そこにエディタを開く）
  if (draft && (isDirty(draft) || !page)) page = parsePage({ path: draft.base.path, content: draft.content, sha: draft.base.sha });
  const exists = (ref: string) => kb.index.resolve(ref) !== null;

  if (!page) {
    // まだないページ。見出しとバックリンクだけ。「編集」で新しいページとして書き始める
    document.title = `${name} - web-b2`;
    root.innerHTML = `<article class="page missing"><div class="tools"></div><h1>${escapeHtml(name)}</h1><p class="note">まだないページ</p></article>`;
    if (synced) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "edit";
      editButton.textContent = "編集";
      editButton.addEventListener("click", () => void startNewPage(kb, scripting, name, root));
      root.querySelector(".tools")!.append(editButton);
    }
    await appendRelated(kb, name, root, seq);
    return;
  }

  const body = await scripting.expand(page.body, { name: page.name, stack: [page.name] });
  if (stale(seq)) return;

  document.title = `${page.title} - web-b2`;
  // H1 は本文の中にあるので、ないときだけ name を見出しにする
  const heading = page.h1 === null ? `<h1 class="from-name">${escapeHtml(page.name)}</h1>` : "";
  // settings ページには、script.js の構文エラー・実行時エラーを先頭に出す（SPEC.md「マクロ」）
  const scriptError =
    scripting.error !== null && page.name === scripting.settingsName
      ? `<p class="script-error">script.js を実行できない: ${escapeHtml(scripting.error)}</p>`
      : "";
  const html = renderMarkdown(body, { pagePath: page.path, exists });
  // 先頭はスクリプトのエラー、次に「編集」の道具、見出し、本文の順
  root.innerHTML = `<article class="page">${scriptError}<div class="tools"></div>${heading}<div class="body">${html}</div></article>`;

  // 「編集」でその場をエディタにし、「表示」で下書きを解析して描き直す（SPEC.md「編集と保存」）
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "edit";
  editButton.textContent = "編集";
  editButton.addEventListener("click", () => void startEdit(kb, scripting, page, name, root, seq));
  root.querySelector(".tools")!.append(editButton);

  // 作成日・更新日は見出しの直後に置く。見出しがなければ本文の前
  const dates = document.createElement("p");
  dates.className = "dates";
  dates.textContent = [page.created ? `作成 ${page.created}` : "", page.updated ? `更新 ${page.updated}` : ""]
    .filter((s) => s !== "")
    .join(" / ");
  const h1 = root.querySelector("article h1");
  if (h1) h1.insertAdjacentElement("afterend", dates);
  else root.querySelector("article")!.prepend(dates);

  // 本文を先に見せてから、逆引き（初回は構築を待つ）と図。触る場所が別なので並べて進める
  await Promise.all([appendRelated(kb, page.name, root, seq), drawMermaid(root, seq)]);
}

// 本文の場所（H1 と日付を含む）をエディタに差し替える。中身はファイルそのもの（front matter を含む）か、あれば下書き
// viewName は開いたときの名前（URL の name。新しいページでは title になる名前）。「表示」で同じ名前を描き直す
async function startEdit(kb: Kb, scripting: Scripting, page: Page, viewName: string, root: HTMLElement, seq: number): Promise<void> {
  editingPath = page.path;
  // 下書き（新しいページも含む）があればそれを続け、なければ控えのファイルから始める
  let draft = getDraft(page.path);
  if (!draft) {
    const file = await kb.content(page.path);
    if (stale(seq)) return;
    if (!file) {
      editingPath = null;
      return;
    }
    draft = openDraft(file);
  }
  const body = root.querySelector<HTMLElement>(".body");
  const tools = root.querySelector<HTMLElement>(".tools");
  if (!body || !tools) {
    editingPath = null;
    return;
  }

  const host = document.createElement("div");
  host.className = "editor";
  body.replaceWith(host);
  tools.innerHTML = "";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "view";
  done.textContent = "表示";
  // 描き直す。下書きがあればそれが表示に反映される。エディタの読み込み中に押しても効く
  done.addEventListener("click", () => void showPage(kb, scripting, viewName, root, beginRender()));
  tools.append(done);

  const view = await createEditor(host, draft.content, (value) => updateDraft(page.path, value));
  // 読み込みのあいだに別のページへ移っていたら、いま表示中のエディタには触らずに捨てる
  if (stale(seq)) {
    view.destroy();
    return;
  }
  editor = view;
  view.focus();
}

// まだないページから書き始める。新しいページの下書きを作り、ページとして描いてからエディタにする
async function startNewPage(kb: Kb, scripting: Scripting, name: string, root: HTMLElement): Promise<void> {
  const seq = beginRender();
  // path が決まる前から編集中とみなす（同期後の描き直しに割り込まれないように）
  editingPath = "";
  let dir: string;
  try {
    dir = await pageDir();
  } catch (e) {
    if (stale(seq)) return;
    editingPath = null;
    const tools = root.querySelector<HTMLElement>(".tools");
    if (tools) tools.textContent = `新しいページを置く場所を取れない: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  if (stale(seq)) return;
  // 同じ秒に別の名前から作った下書きや、既にあるファイルと path が重ならないよう、重なれば1秒進める
  const now = new Date();
  let file = newPageFile(name, dir, now);
  const taken = (p: string) => getDraft(p) !== undefined || [...kb.index.pages.values()].some((m) => m.path === p);
  for (let i = 0; i < 60 && taken(file.path); i++) {
    now.setSeconds(now.getSeconds() + 1);
    file = newPageFile(name, dir, now);
  }
  const { path, content } = file;
  const draft = openNewDraft(name, path, content);
  await renderPage(kb, scripting, name, root, seq);
  if (stale(seq)) return;
  const page = parsePage({ path: draft.base.path, content: draft.content, sha: null });
  await startEdit(kb, scripting, page, name, root, seq);
}

// 一覧の1項目。同じ title のページを見分けられるように、name を title 属性に入れる
function pageItem(p: PageMeta): string {
  return `<li><a href="${pageUrl(p.name)}" class="wikilink" title="${escapeHtml(p.name)}">${escapeHtml(p.title)}</a></li>`;
}

// ページの末尾に「このページへのリンク」（バックリンク）と「2 hop link」を足す（SPEC.md「リンクの解決」）。
// バックリンクはないときも見出しを出す。2 hop link はあるときだけ、リンク先ごとにまとめる。
// 逆引きを読めなかったときは、その旨を末尾に出す（本文は出ている）
async function appendRelated(kb: Kb, name: string, root: HTMLElement, seq: number): Promise<void> {
  let backlinks: PageMeta[];
  let hops: Awaited<ReturnType<Kb["twoHop"]>>;
  try {
    [backlinks, hops] = await Promise.all([kb.backlinks(name), kb.twoHop(name)]);
  } catch (e) {
    if (stale(seq)) return;
    const section = document.createElement("section");
    section.className = "backlinks";
    section.innerHTML = `<h2>このページへのリンク</h2><p class="note">読めなかった: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
    root.querySelector("article")?.append(section);
    return;
  }
  if (stale(seq)) return;
  const article = root.querySelector("article");
  if (!article) return;

  const back = document.createElement("section");
  back.className = "backlinks";
  back.innerHTML = `<h2>このページへのリンク</h2>${
    backlinks.length === 0 ? `<p class="note">なし</p>` : `<ul>${backlinks.map(pageItem).join("")}</ul>`
  }`;
  article.append(back);

  if (hops.length === 0) return;
  const hop = document.createElement("section");
  hop.className = "two-hop";
  hop.innerHTML = `<h2>2 hop link</h2>${hops
    .map((h) => {
      const label = h.target.page ? h.target.page.title : h.target.name;
      const cls = h.target.page ? "wikilink" : "wikilink missing";
      return `<div class="hop"><h3><a href="${pageUrl(h.target.name)}" class="${cls}">${escapeHtml(label)}</a></h3><ul>${h.pages.map(pageItem).join("")}</ul></div>`;
    })
    .join("")}`;
  article.append(hop);
}

// 一覧と検索結果（/all）。q が空なら全ページの一覧。300件で切ったときはその旨を出す。
// loading は本文をまだ読めていない（タイトルだけで探している）とき
export function showAll(kb: Kb, root: HTMLElement, note: string, q: string, result: SearchResult, loading = false): void {
  document.title = q === "" ? "web-b2" : `${q} - web-b2`;
  const items = result.pages.map(pageItem).join("");
  const truncated = result.total > result.pages.length ? `（先頭の${result.pages.length}件を表示）` : "";
  const count = q === "" ? statusText(kb, note) + truncated : `${result.total}件${truncated}${loading ? "（本文を読み込み中）" : ""}`;
  root.innerHTML = `<h1>${q === "" ? "web-b2" : escapeHtml(q)}</h1><p id="status">${escapeHtml(count)}</p><ul id="pages">${items}</ul>`;
}

export function statusText(kb: Kb, note: string): string {
  return `${kb.index.size}ページ（${note}）`;
}
