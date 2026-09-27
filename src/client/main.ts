import { today } from "./date";
import { Kb } from "./kb";
import { pageUrl } from "./render";
import { type Route, startRouter } from "./router";
import { search } from "./search";
import type { Settings } from "./settings";
import { ApiSource } from "./source";
import { type FileStore, IdbStore, MemoryStore } from "./store";
import { beginRender, escapeHtml, showAll, showPage, stale, statusText } from "./view";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header id="top"><nav id="links"></nav><input id="q" type="search" placeholder="検索" autocomplete="off" aria-label="検索"></header><main id="view"><p id="status">読み込み中</p></main>`;
const view = document.querySelector<HTMLElement>("#view")!;
const q = document.querySelector<HTMLInputElement>("#q")!;
const links = document.querySelector<HTMLElement>("#links")!;

// settings の「ヘッダー」を検索欄の左に並べ、style.css をページ全体に当てる
function applySettings(kb: Kb, settings: Settings): void {
  links.replaceChildren(
    ...settings.header.map((item) => {
      const a = document.createElement("a");
      a.href = item.page ? pageUrl(item.target) : item.target;
      a.textContent = item.page && item.label === item.target ? (kb.index.resolve(item.target)?.[1].title ?? item.target) : item.label;
      return a;
    }),
  );
  let style = document.querySelector<HTMLStyleElement>("#user-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "user-style";
    document.head.append(style);
  }
  style.textContent = settings.css ?? "";
}

// `/` で開くページ。settings の「トップ」の最初の [[リンク]]。なければ今日の日付ページ。
// マクロの展開は段階4なので、{{ }} が残っていれば指定なしとみなす
function homeName(settings: Settings): string {
  return settings.top !== null && !settings.top.includes("{{") ? settings.top : today();
}

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

function allUrl(query: string): string {
  return query === "" ? "/all" : `/all?q=${encodeURIComponent(query)}`;
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

  let settings = await kb.settings();
  applySettings(kb, settings);

  // 差分を取る前の一覧には、控えの状態を添える。取り終えたら結果に差し替える
  let note = kb.rebuilt ? "控えから解析し直した。差分を確認中" : "差分を確認中";

  // 一覧と検索結果。本文は最初の検索のときに読む（読み終わるまではタイトルだけで探し、読めたら描き直す）
  let bodies: ReadonlyMap<string, string> | null = null;
  const showResults = (query: string, seq: number) => {
    const bodyOf = (path: string) => bodies?.get(path) ?? "";
    showAll(kb, view, note, query, search(kb.index.pages.values(), query, bodyOf), query !== "" && bodies === null);
    if (query !== "" && bodies === null) {
      void kb.bodies().then(
        (map) => {
          bodies = map;
          if (!stale(seq)) showAll(kb, view, note, query, search(kb.index.pages.values(), query, bodyOf));
        },
        (e) => console.warn(`本文を読めないのでタイトルだけで探す: ${message(e)}`),
      );
    }
  };

  const render = (route: Route) => {
    const seq = beginRender();
    // 検索欄の中身は URL に合わせる。/all 以外では空
    const query = route.kind === "all" ? route.q : "";
    if (document.activeElement !== q) q.value = query;
    switch (route.kind) {
      case "page":
        void showPage(kb, route.name, view, seq);
        break;
      case "home":
        // URL を /p/<name> に差し替えて描く（履歴には / を残さない）
        router.replace(pageUrl(homeName(settings)));
        break;
      case "all":
        showResults(query, seq);
        break;
      default:
        view.innerHTML = `<h1>web-b2</h1><p>このURLはまだ扱えない: ${escapeHtml(route.kind === "unknown" ? route.path : route.kind)}</p>`;
    }
  };
  // 戻る・進むのときは、欄にフォーカスがあっても URL に合わせる（render は入力中の欄を触らない）
  window.addEventListener("popstate", () => q.blur());
  const router = startRouter(render);
  render(router.current());

  // 検索欄。入力に合わせて /all?q= に移って結果を差し替える。IME の変換中は何もしない。
  // /all にいるあいだは履歴を積まない（replace）。
  // 全文の走査は1万ページで200ms（docs/perf.md）かかるので、打鍵ごとではなく次のフレームで最後の値だけ検索する
  let composing = false;
  let scheduled = false;
  const runSearch = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const url = allUrl(q.value.trim());
      if (router.current().kind === "all") router.replace(url);
      else router.navigate(url);
    });
  };
  q.addEventListener("compositionstart", () => {
    composing = true;
  });
  q.addEventListener("compositionend", () => {
    composing = false;
    runSearch();
  });
  q.addEventListener("input", (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    runSearch();
  });

  await nextFrame();
  performance.mark("reverse:start");
  await kb.prepareBacklinks();
  performance.measure("reverse", "reverse:start");

  // 差分を取れないとき（オフライン、Accessのセッション切れ）は控えの索引のまま使い、その旨を出す
  performance.mark("sync:start");
  let changed = false;
  try {
    const result = await kb.sync(new ApiSource());
    note = `${result.fetched.length}件を読み直し`;
    changed = result.fetched.length + result.removed.length > 0;
  } catch (e) {
    note = `差分を取れなかったので控えを表示: ${message(e)}`;
  }
  performance.measure("sync", "sync:start");
  // 何か変わったときだけ表示を作り直す（変わっていないのに作り直すと、図が描き直されて選択が消える。段階5では編集中の内容も）。
  // 変わっていなければ一覧の状態の文だけ差し替える
  const route = router.current();
  if (changed) {
    // settings が変わっていることもあるので読み直す
    settings = await kb.settings();
    applySettings(kb, settings);
    render(route);
  } else if (route.kind === "all" && route.q === "") {
    const status = document.querySelector("#status");
    if (status) status.textContent = statusText(kb, note);
  }
}

void start();
