// 画面の描画。ページ（/p/<name>）と、いまは仮の一覧（/）
import type { Kb } from "./kb";
import type { PageMeta } from "./page";
import { escapeHtml, pageUrl, renderMarkdown } from "./render";
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

export async function showPage(kb: Kb, name: string, root: HTMLElement, seq: number): Promise<void> {
  const page = await kb.page(name);
  if (stale(seq)) return;
  const exists = (ref: string) => kb.index.resolve(ref) !== null;

  if (!page) {
    // まだないページ。見出しとバックリンクだけ
    document.title = `${name} - web-b2`;
    root.innerHTML = `<article class="page missing"><h1>${escapeHtml(name)}</h1><p class="note">まだないページ</p></article>`;
    await appendRelated(kb, name, root, seq);
    return;
  }

  document.title = `${page.title} - web-b2`;
  // H1 は本文の中にあるので、ないときだけ name を見出しにする
  const heading = page.h1 === null ? `<h1 class="from-name">${escapeHtml(page.name)}</h1>` : "";
  const html = renderMarkdown(page.body, { pagePath: page.path, exists });
  root.innerHTML = `<article class="page">${heading}<div class="body">${html}</div></article>`;

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
