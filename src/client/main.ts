import { today } from "./date";
import { byUpdatedDesc } from "./kb-index";
import { IdbStore } from "./store";
import { ApiSource, buildIndex, sync } from "./sync";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<h1>web-b2</h1><p>${today()}</p><p id="status">読み込み中</p><ul id="pages"></ul>`;

// 起動時に控えを差分で更新し、索引を作る。表示は段階3で作るので、いまは一覧を出すだけ
async function start(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status")!;
  const list = document.querySelector<HTMLUListElement>("#pages")!;
  try {
    const store = await IdbStore.open();
    const result = await sync(store, new ApiSource());
    const index = buildIndex(result.files);
    status.textContent = `${index.size}ページ（${result.fetched.length}件を読み直し）`;
    for (const page of [...index.pages.values()].sort(byUpdatedDesc)) {
      const li = document.createElement("li");
      li.textContent = page.title;
      list.append(li);
    }
  } catch (e) {
    status.textContent = `読み込みに失敗: ${e instanceof Error ? e.message : String(e)}`;
  }
}

void start();
