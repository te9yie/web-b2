import { showCapture } from "./capture";
import { today } from "./date";
import { Kb } from "./kb";
import { pageUrl } from "./render";
import { type Route, startRouter } from "./router";
import { search } from "./search";
import { firstLink } from "./md";
import { Scripting } from "./scripting";
import { dropClean, getDraft, resolveConflict } from "./drafts";
import { SAVE_DELAY, Saver } from "./saver";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { ApiSource } from "./source";
import { type FileStore, IdbStore, MemoryStore } from "./store";
import {
  beginRender,
  currentEditingPath,
  escapeHtml,
  insertConflict,
  isEditing,
  leavePage,
  markSyncFailed,
  markSynced,
  setConflictResolver,
  setPageDir,
  showAll,
  showPage,
  stale,
  statusText,
} from "./view";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header id="top"><nav id="links"></nav><input id="q" type="search" placeholder="検索" autocomplete="off" aria-label="検索"><span id="save-note"></span></header><main id="view"><p id="status">読み込み中</p></main>`;
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

// `/` で開くページ。settings の「トップ」をマクロで展開してからの最初の [[リンク]]。なければ今日の日付ページ
async function homeName(settings: Settings, scripting: Scripting): Promise<string> {
  if (settings.topSection === null) return today();
  const name = settings.name ?? "";
  const expanded = await scripting.expand(settings.topSection, { name, stack: [name] });
  return firstLink(expanded) ?? today();
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

  // settings を読めなくても本体は動かす（既定の値）
  const loadSettings = async () => {
    try {
      return await kb.settings();
    } catch (e) {
      console.warn(`settings を読めないので既定の値で動かす: ${message(e)}`);
      return DEFAULT_SETTINGS;
    }
  };
  const scripting = new Scripting(kb);
  const source = new ApiSource();
  setPageDir(() => source.dir());
  // 保存。結果はヘッダーの右端に出す（失敗したときだけ文が残る）
  const saveNote = document.querySelector<HTMLElement>("#save-note")!;
  // 表示中のページの path（競合の表示に使う）
  const currentPagePath = (): string | null => {
    const route = router.current();
    return route.kind === "page" ? (kb.index.resolve(route.name)?.[1].path ?? null) : null;
  };
  const saver = new Saver(kb, source, today, SAVE_DELAY, (result) => {
    if (result.conflict !== undefined) {
      saveNote.textContent = "別の場所で変わっている";
      saveNote.title = "そのページを開くと、相手の内容と選択肢が出る";
      // いま見ているページなら競合の表示を出す。編集中はエディタを閉じずに差し込む（カーソルと変換中の文字を失わないため）
      if (currentPagePath() === result.path) {
        if (isEditing()) insertConflict(view, result.path);
        else render(router.current());
      }
      return;
    }
    saveNote.textContent = result.ok ? "" : `保存できない: ${result.error}`;
    saveNote.title = result.ok ? "" : "下書きは残っている。次の編集かページ移動でもう一度送る";
  });
  // 競合の解決。上書きなら基準を相手の sha にして送り、そろえるなら下書きを捨てる。どちらも描き直す
  setConflictResolver((path, choice) => {
    // 相手が消していて「捨てる」を選んだら、控えと索引からもここで消す
    const gone = getDraft(path)?.conflict?.sha === null;
    resolveConflict(path, choice);
    saveNote.textContent = "";
    const after = () => {
      if (currentPagePath() === path || gone) render(router.current());
    };
    if (choice === "mine") void saver.flush().then(after);
    else if (gone) void kb.remove(path).then(after);
    else after();
  });
  // タブを閉じるときに保存する。keepalive の fetch はページが消えても送り終える。
  // 裏に回るとき（タブの切り替え）はページが消えないので普通の fetch で保存する（DECISIONS.md 2026-09-27「保存時の updated」）
  window.addEventListener("pagehide", () => void saver.flush({ keepalive: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void saver.flush();
  });

  let settings = await loadSettings();
  applySettings(kb, settings);
  scripting.load(settings.script, settings.name);

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
    // 前のルートの編集を閉じ、基準と同じ下書きを片付け、変わっている下書きを保存する（ページ移動での保存）。
    // 保存できた下書きも片付けるが、そのときエディタで開いているページのものは残す（開いたばかりの下書きを消すと入力が届かなくなる）
    leavePage();
    dropClean();
    void saver.flush().then((results) => {
      for (const r of results) if (r.ok && r.path !== currentEditingPath()) dropClean(r.path);
    });
    // 検索欄の中身は URL に合わせる。/all 以外では空
    const query = route.kind === "all" ? route.q : "";
    if (document.activeElement !== q) q.value = query;
    switch (route.kind) {
      case "page":
        void showPage(kb, scripting, route.name, view, seq);
        break;
      case "home":
        // URL を /p/<name> に差し替えて描く（履歴には / を残さない）。
        // 同じページから「今日」を押したときは、同じ URL を重ねずに戻る
        void homeName(settings, scripting).then((name) => {
          if (stale(seq)) return;
          const target = pageUrl(name);
          if (router.previous() === target) history.back();
          else router.replace(target);
        });
        break;
      case "all":
        showResults(query, seq);
        break;
      case "new":
      case "append":
        void showCapture({ kb, saver, router, pageDir: () => source.dir() }, route, view, seq);
        break;
      case "unknown":
        view.innerHTML = `<h1>web-b2</h1><p>このURLはまだ扱えない: ${escapeHtml(route.path)}</p>`;
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
  try {
    await kb.prepareBacklinks();
  } catch (e) {
    // ここで止まると差分を取らないので、取り込みの確認画面が「差分を確認中」のまま待たないよう、失敗を知らせる
    markSyncFailed(`逆引きを読めない: ${message(e)}`);
    throw e;
  }
  performance.measure("reverse", "reverse:start");

  // 差分を取れないとき（オフライン、Accessのセッション切れ）は控えの索引のまま使い、その旨を出す
  performance.mark("sync:start");
  let changed = false;
  const revision = kb.revision;
  try {
    const result = await kb.sync(source);
    note = `${result.fetched.length}件を読み直し`;
    changed = result.fetched.length + result.removed.length > 0;
    // 索引が最新になったので、まだないページから新しいページを作れる。差分を取れなかったときは（控えが古いので）作らせない
    markSynced();
  } catch (e) {
    note = `差分を取れなかったので控えを表示: ${message(e)}`;
    // 途中で失敗しても、それまでに読んだ分は索引に入っている（tarball が途中で切れた初回など）ので描き直す
    changed = kb.revision !== revision;
    markSyncFailed(message(e));
  }
  performance.measure("sync", "sync:start");
  // 何か変わったときだけ表示を作り直す（変わっていないのに作り直すと、図が描き直されて選択が消える。段階5では編集中の内容も）。
  // 変わっていなければ一覧の状態の文だけ差し替える
  const route = router.current();
  if (changed) {
    // settings が変わっていることもあるので読み直す
    settings = await loadSettings();
    applySettings(kb, settings);
    scripting.load(settings.script, settings.name);
  }
  // まだないページは、同期が済んだので「編集」を出すために描き直す
  const missingPage = route.kind === "page" && kb.index.resolve(route.name) === null;
  // 取り込みの確認画面は描き直さない（<textarea> で直した本文が消える）。同期を待って自分で行き先を出す
  const capturing = route.kind === "new" || route.kind === "append";
  if ((changed || missingPage) && !capturing) {
    // 編集中は描き直さない（下書きは残るので、次の表示で反映される）
    if (!isEditing()) render(route);
  } else if (route.kind === "all" && route.q === "") {
    const status = document.querySelector("#status");
    if (status) status.textContent = statusText(kb, note);
  }
}

void start();
