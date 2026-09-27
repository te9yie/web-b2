// 画面の描画。ページ（/p/<name>）と、いまは仮の一覧（/）
import type { Kb } from "./kb";
import { byUpdatedDesc } from "./kb-index";
import { escapeHtml, pageUrl, renderMarkdown } from "./render";

// Mermaid は大きいので、図のあるページを初めて表示するときに読み込む
async function drawMermaid(root: HTMLElement): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (nodes.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false });
  try {
    await mermaid.run({ nodes });
  } catch (e) {
    // 文法の誤りは mermaid が図の場所にメッセージを出す。ここでは記録だけ
    console.warn("Mermaid の描画に失敗", e);
  }
}

// 描画中に別のページへ移ったとき、古い描画結果を出さないための通し番号
let sequence = 0;

export async function showPage(kb: Kb, name: string, root: HTMLElement): Promise<void> {
  const seq = ++sequence;
  const page = await kb.page(name);
  if (seq !== sequence) return;
  const exists = (ref: string) => kb.index.resolve(ref) !== null;

  if (!page) {
    // まだないページ。見出しだけ。バックリンクは次のタスクで足す
    document.title = `${name} - web-b2`;
    root.innerHTML = `<article class="page missing"><h1>${escapeHtml(name)}</h1><p class="note">まだないページ</p></article>`;
    return;
  }

  document.title = `${page.title} - web-b2`;
  const dates = [page.created ? `作成 ${escapeHtml(page.created)}` : "", page.updated ? `更新 ${escapeHtml(page.updated)}` : ""]
    .filter((s) => s !== "")
    .join(" / ");
  // H1 は本文の中にあるので、ないときだけ name を見出しにする
  const heading = page.h1 === null ? `<h1 class="from-name">${escapeHtml(page.name)}</h1>` : "";
  const html = renderMarkdown(page.body, { pagePath: page.path, exists });
  root.innerHTML = `<article class="page">${heading}<p class="dates">${dates}</p><div class="body">${html}</div></article>`;
  await drawMermaid(root);
}

export function showList(kb: Kb, root: HTMLElement, note: string): void {
  document.title = "web-b2";
  const items = [...kb.index.pages.values()]
    .sort(byUpdatedDesc)
    .map((p) => `<li><a href="${pageUrl(p.name)}">${escapeHtml(p.title)}</a></li>`)
    .join("");
  root.innerHTML = `<h1>web-b2</h1><p id="status">${escapeHtml(`${kb.index.size}ページ（${note}）`)}</p><ul id="pages">${items}</ul>`;
}
