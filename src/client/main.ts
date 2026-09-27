import { today } from "./date";
import { Kb } from "./kb";
import { byUpdatedDesc } from "./kb-index";
import { ApiSource } from "./source";
import { type FileStore, IdbStore, MemoryStore } from "./store";

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

function render(kb: Kb, note: string): void {
  const status = document.querySelector<HTMLParagraphElement>("#status")!;
  const list = document.querySelector<HTMLUListElement>("#pages")!;
  status.textContent = `${kb.index.size}ページ（${note}）`;
  list.replaceChildren(
    ...[...kb.index.pages.values()].sort(byUpdatedDesc).map((page) => {
      const li = document.createElement("li");
      li.textContent = page.title;
      return li;
    }),
  );
}

// 描画を1回挟む
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// 起動。控えの解析結果から索引を作って先に出し、逆引きを作り、その後で差分を取って反映する。
// 表示は段階3で作るので、いまは一覧を出すだけ。
// performance.measure の open・reverse・sync は perf/ の計測で読む
async function start(): Promise<void> {
  performance.mark("open:start");
  const store = await openStore();
  performance.measure("open:store", "open:start");
  performance.mark("open:record");
  const kb = await Kb.open(store, (step, ms) => performance.measure(`open:${step}`, { start: performance.now() - ms }));
  performance.measure("open:record+index", "open:record");
  performance.measure("open", "open:start");
  render(kb, kb.rebuilt ? "控えから解析し直した。差分を確認中" : "差分を確認中");

  await nextFrame();
  performance.mark("reverse:start");
  await kb.prepareBacklinks();
  performance.measure("reverse", "reverse:start");

  // 差分を取れないとき（オフライン、Accessのセッション切れ）は控えの索引のまま使い、その旨を出す
  performance.mark("sync:start");
  try {
    const result = await kb.sync(new ApiSource());
    render(kb, `${result.fetched.length}件を読み直し`);
  } catch (e) {
    render(kb, `差分を取れなかったので控えを表示: ${message(e)}`);
  }
  performance.measure("sync", "sync:start");
}

void start();
