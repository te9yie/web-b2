import { today } from "./date";
import { byUpdatedDesc } from "./kb-index";
import { type FileStore, IdbStore, MemoryStore } from "./store";
import { ApiSource, buildIndex, sync } from "./sync";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<h1>web-b2</h1><p>${today()}</p><p id="status">読み込み中</p><ul id="pages"></ul>`;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// IndexedDB を開けない環境（サイトデータを拒否した設定など）では、控えを持たずに毎回読む
async function openStore(): Promise<FileStore> {
  try {
    return await IdbStore.open();
  } catch (e) {
    console.warn(`IndexedDB を開けないので控えを持たずに動かす: ${message(e)}`);
    return new MemoryStore();
  }
}

// 起動時に控えを差分で更新し、索引を作る。表示は段階3で作るので、いまは一覧を出すだけ。
// 差分を取れないとき（オフライン、Accessのセッション切れ）は控えだけで索引を作り、その旨を出す
async function start(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status")!;
  const list = document.querySelector<HTMLUListElement>("#pages")!;
  performance.mark("sync:start");
  const store = await openStore();
  let files;
  let note: string;
  try {
    const result = await sync(store, new ApiSource());
    files = result.files;
    note = `${result.fetched.length}件を読み直し`;
  } catch (e) {
    files = await store.all();
    note = `差分を取れなかったので控えを表示: ${message(e)}`;
  }
  // 計測用（perf/）。控えを開いて差分を取るまでと、解析して索引を作るまでを分けて出す
  performance.measure("sync", "sync:start");
  performance.mark("index:start");
  const index = buildIndex(files);
  performance.measure("index", "index:start");
  status.textContent = `${index.size}ページ（${note}）`;
  for (const page of [...index.pages.values()].sort(byUpdatedDesc)) {
    const li = document.createElement("li");
    li.textContent = page.title;
    list.append(li);
  }
}

void start();
