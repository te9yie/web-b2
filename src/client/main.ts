import { Kb } from "./kb";
import { type Route, startRouter } from "./router";
import { ApiSource } from "./source";
import { type FileStore, IdbStore, MemoryStore } from "./store";
import { showList, showPage } from "./view";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<main id="view"><p id="status">読み込み中</p></main>`;
const view = document.querySelector<HTMLElement>("#view")!;

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

// 描画を1回挟む。見えていないタブでは requestAnimationFrame が止まるので、表に出るまで逆引きも差分も取らない。
// それで失うものはないので、そのままにしている
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// 起動。控えの解析結果から索引を作って先に出し、逆引きを作り、その後で差分を取って反映する。
// performance.measure の open・reverse・sync は perf/ の計測で読む
async function start(): Promise<void> {
  performance.mark("open:start");
  const store = await openStore();
  performance.measure("open:store", "open:start");
  performance.mark("open:record");
  const kb = await Kb.open(store, (step, ms) => performance.measure(`open:${step}`, { start: performance.now() - ms }));
  performance.measure("open:record+index", "open:record");
  performance.measure("open", "open:start");

  // 差分を取る前の一覧には、控えの状態を添える。取り終えたら結果に差し替える
  let note = kb.rebuilt ? "控えから解析し直した。差分を確認中" : "差分を確認中";
  const render = (route: Route) => {
    switch (route.kind) {
      case "page":
        void showPage(kb, route.name, view);
        break;
      case "home":
      case "all":
        showList(kb, view, note);
        break;
      default:
        view.innerHTML = `<h1>web-b2</h1><p>このURLはまだ扱えない: ${route.kind === "unknown" ? route.path : route.kind}</p>`;
    }
  };
  const router = startRouter(render);

  await nextFrame();
  performance.mark("reverse:start");
  await kb.prepareBacklinks();
  performance.measure("reverse", "reverse:start");

  // 差分を取れないとき（オフライン、Accessのセッション切れ）は控えの索引のまま使い、その旨を出す
  performance.mark("sync:start");
  try {
    const result = await kb.sync(new ApiSource());
    note = `${result.fetched.length}件を読み直し`;
  } catch (e) {
    note = `差分を取れなかったので控えを表示: ${message(e)}`;
  }
  performance.measure("sync", "sync:start");
  // 差分で変わったものを表示に反映する
  render(router.current());
}

void start();
