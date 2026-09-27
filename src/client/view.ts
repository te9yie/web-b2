// 画面の描画。ページ（/p/<name>）と、いまは仮の一覧（/）
import type { Kb } from "./kb";
import { byUpdatedDesc } from "./kb-index";
import { escapeHtml, pageUrl, renderMarkdown } from "./render";

export { escapeHtml };

// 描画の通し番号。描画を始めるたびに beginRender() で進め、await のあとに番号が変わっていたら古い描画を捨てる
let current = 0;
export function beginRender(): number {
  return ++current;
}
function stale(seq: number): boolean {
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
    // まだないページ。見出しだけ。バックリンクは次のタスクで足す
    document.title = `${name} - web-b2`;
    root.innerHTML = `<article class="page missing"><h1>${escapeHtml(name)}</h1><p class="note">まだないページ</p></article>`;
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

  await drawMermaid(root, seq);
}

export function showList(kb: Kb, root: HTMLElement, note: string): void {
  document.title = "web-b2";
  const items = [...kb.index.pages.values()]
    .sort(byUpdatedDesc)
    .map((p) => `<li><a href="${pageUrl(p.name)}">${escapeHtml(p.title)}</a></li>`)
    .join("");
  root.innerHTML = `<h1>web-b2</h1><p id="status">${escapeHtml(statusText(kb, note))}</p><ul id="pages">${items}</ul>`;
}

export function statusText(kb: Kb, note: string): string {
  return `${kb.index.size}ページ（${note}）`;
}
