// 取り込み（SPEC.md「URL」の /new と /append）。ブックマークレットの受け口。
// 開いただけでは何も書かない。行き先と本文を確認画面で見せ、「保存」を押したときに書く
// （DECISIONS.md 2026-09-28「/new と /append は確認画面で「保存」を押してから書く」）。
// 本文は Markdown として描かず、<textarea> の文字として見せる（HTML を消毒しない表示なので、描くと確認画面でスクリプトが動く）。
// 保存は編集と同じ下書きと Saver で行う

import { clearDraft, draftForNewPage, getDraft, isDirty, normalizeEol, openDraft, openNewDraft, updateDraft } from "./drafts";
import type { Kb } from "./kb";
import { type KbIndex, refName } from "./kb-index";
import { type PageMeta, nameOf } from "./page";
import { pageUrl } from "./render";
import type { Route, Router } from "./router";
import type { Saver } from "./saver";
import { SETTINGS_NAME } from "./settings";
import { allocateNewPageFile, stale, whenSynced } from "./view";

export type CaptureRoute = Extract<Route, { kind: "new" | "append" }>;

// title の空白（改行を含む）を1つの半角空白にまとめて前後を落とす。空なら null
export function captureTitle(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

// 本文の改行を LF にそろえ（\r\n と単独の \r）、末尾の改行を落とす。先頭と行中の空白は変えない
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

function isBlank(s: string): boolean {
  return s.trim() === "";
}

// 既存の中身の末尾に本文を足す。区切りは空行1つで、既存の末尾の空白は変えない。結果は \n で終わる。
// 本文が空なら中身をそのまま返す
export function appendBody(content: string, body: string): string {
  if (isBlank(body)) return content;
  if (content === "" || content.endsWith("\n\n")) return `${content}${body}\n`;
  if (content.endsWith("\n")) return `${content}\n${body}\n`;
  return `${content}\n\n${body}\n`;
}

// 本文がすでに末尾にあるか（同じリンクを二度開いたときの注意に使う）。前後の空白を落として比べる
export function endsWithBody(content: string, body: string): boolean {
  const b = body.trim();
  return b !== "" && content.trimEnd().endsWith(b);
}

// 行き先。索引だけを見て決める（差分の同期の後に呼ぶ）。settings は行き先が settings ページか
export type CapturePlan =
  // 新しいページを作る。name が null なら title なし（時刻のファイル名、見出しなし）
  | { kind: "create"; name: string | null; settings: boolean }
  // 既存のページの末尾に足す。name は解決した name
  | { kind: "append"; name: string; meta: PageMeta; settings: boolean }
  // 保存できない。name があれば、そのページへのリンクを添える
  | { kind: "invalid"; reason: string; name?: string };

export function planCapture(index: KbIndex, route: CaptureRoute): CapturePlan {
  const body = normalizeBody(route.body);
  const settingsName = index.resolve(SETTINGS_NAME)?.[0] ?? null;
  if (route.kind === "new") {
    const title = captureTitle(route.title);
    if (title === null) {
      return isBlank(body) ? { kind: "invalid", reason: "title も body もない" } : { kind: "create", name: null, settings: false };
    }
    const found = index.resolve(title);
    if (!found) return { kind: "create", name: title, settings: title === SETTINGS_NAME };
    // 同じ名前のページを新しく作らず、そのページへの追記にする（DECISIONS.md 2026-09-28）
    if (isBlank(body)) return { kind: "invalid", reason: "同じ名前のページがある", name: found[0] };
    return { kind: "append", name: found[0], meta: found[1], settings: found[0] === settingsName };
  }
  const page = refName(captureTitle(route.page) ?? "");
  if (page === "") return { kind: "invalid", reason: "page がない" };
  if (isBlank(body)) return { kind: "invalid", reason: "body がない", name: index.resolve(page)?.[0] };
  const found = index.resolve(page);
  if (!found) return { kind: "create", name: page, settings: page === SETTINGS_NAME };
  return { kind: "append", name: found[0], meta: found[1], settings: found[0] === settingsName };
}

// 本文の見た目が HTML か。`a < b` のような比較は当たらない
const HTML_LIKE = [/<[a-z!/]/i, /javascript:/i, /\son[a-z]+\s*=/i];

// 注意の文。保存は止めない。target は行き先が決まってから渡す（content は追記するときの既存の中身）
export function captureWarnings(body: string, target: { settings: boolean; content: string | null } | null = null): string[] {
  const warnings: string[] = [];
  if (HTML_LIKE.some((re) => re.test(body))) warnings.push("本文に HTML が含まれている。保存すると、表示のときにそのまま動く（スクリプトも）");
  if (body.includes("�")) warnings.push("文字化けした文字（�）が含まれている。ブックマークレットのエンコードを確かめる");
  if (target?.settings) warnings.push("settings ページに書く。script.js や style.css のコードブロックを含むと、次の表示から動く");
  if (target?.content != null && endsWithBody(target.content, body)) warnings.push("同じ内容がすでに末尾にある");
  return warnings;
}

export interface CaptureDeps {
  kb: Kb;
  saver: Saver;
  router: Router;
  // 新しいページを置くディレクトリ（KB_DIR）
  pageDir: () => Promise<string>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function lastLines(content: string, n: number): string {
  return content.replace(/\n+$/, "").split("\n").slice(-n).join("\n");
}

function pageLink(name: string, label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = pageUrl(name);
  a.textContent = label;
  return a;
}

// 確認画面。innerHTML には固定の文字列だけを入れ、URL 由来の文字は textContent と value で入れる
export async function showCapture(deps: CaptureDeps, route: CaptureRoute, root: HTMLElement, seq: number): Promise<void> {
  const { kb, saver, router } = deps;
  const setHeading = (append: boolean) => {
    const label = append ? "追記" : "新しいページ";
    document.title = `${label} - web-b2`;
    root.querySelector(".capture h1")!.textContent = label;
  };
  root.innerHTML = `<article class="capture"><h1></h1><p class="capture-target"></p><ul class="capture-warnings"></ul><label>本文<textarea class="capture-body" rows="12"></textarea></label><pre class="capture-tail" hidden></pre><p class="capture-status"></p><div class="choices"><button type="button" class="save" disabled>保存</button><button type="button" class="cancel">やめる</button></div></article>`;
  setHeading(route.kind === "append");
  const targetEl = root.querySelector<HTMLElement>(".capture-target")!;
  const warningsEl = root.querySelector<HTMLElement>(".capture-warnings")!;
  const textarea = root.querySelector<HTMLTextAreaElement>(".capture-body")!;
  const tailEl = root.querySelector<HTMLElement>(".capture-tail")!;
  const statusEl = root.querySelector<HTMLElement>(".capture-status")!;
  const saveButton = root.querySelector<HTMLButtonElement>("button.save")!;
  root.querySelector("button.cancel")!.addEventListener("click", () => router.replace("/"));
  textarea.value = normalizeBody(route.body);

  // 注意は本文を直すたびに出し直す。行き先が決まるまでは本文だけで見る
  let target: { settings: boolean; content: string | null } | null = null;
  let extra: string[] = [];
  const showWarnings = () => {
    const items = [...captureWarnings(normalizeBody(textarea.value), target), ...extra].map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    });
    warningsEl.replaceChildren(...items);
  };
  textarea.addEventListener("input", showWarnings);
  showWarnings();
  // 保存できないと決まったら「保存」を消し、理由を出す（「やめる」だけ残す）
  const stop = (...parts: (string | Node)[]) => {
    saveButton.remove();
    statusEl.replaceChildren(...parts);
  };

  // 別のサイトの枠の中では保存させない（透明な枠で「保存」を押させる手口を防ぐ）
  if (window.top !== window) {
    stop("枠の中では保存できない");
    return;
  }

  // 索引と控えが最新になってから行き先を決める（古いと既存のページを「まだない」と判断し、追記は古い sha で送る）
  statusEl.textContent = "差分を確認中。終わると保存できる";
  const synced = await whenSynced();
  if (stale(seq)) return;
  if (!synced.ok) {
    stop(`差分を取れないので保存できない: ${synced.error}。再読み込みで試し直す`);
    return;
  }

  const plan = planCapture(kb.index, route);
  if (plan.kind === "invalid") {
    targetEl.textContent = plan.reason;
    if (plan.name !== undefined) targetEl.append("（", pageLink(plan.name, kb.index.get(plan.name)?.title ?? plan.name), "）");
    stop();
    return;
  }
  if (plan.kind === "create") {
    targetEl.textContent = plan.name === null ? "タイトルのない新しいページを作る" : `新しいページ「${plan.name}」を作る`;
    target = { settings: plan.settings, content: null };
  } else {
    setHeading(true);
    targetEl.replaceChildren(
      route.kind === "new" ? "同じ名前のページがあるので、その末尾に足す: " : "",
      "「",
      pageLink(plan.name, plan.meta.title),
      "」の末尾に足す",
    );
    const draft = getDraft(plan.meta.path);
    if (draft?.conflict) {
      stop("このページは競合を解決していない。先にページで解決する: ", pageLink(plan.name, plan.meta.title));
      return;
    }
    const raw = draft?.content ?? (await kb.content(plan.meta.path))?.content;
    if (stale(seq)) return;
    if (raw === undefined) {
      stop("ページを読めない");
      return;
    }
    const content = normalizeEol(raw);
    if (draft && isDirty(draft)) extra = ["保存していない下書きがあり、一緒に保存される"];
    tailEl.textContent = lastLines(content, 10);
    tailEl.hidden = false;
    target = { settings: plan.settings, content };
  }
  showWarnings();
  statusEl.textContent = "";
  saveButton.disabled = false;

  const save = async () => {
    const body = normalizeBody(textarea.value);
    // 見出しだけの新しいページ（title のある /new）のほかは、本文がなければ書くものがない
    if (isBlank(body) && (plan.kind === "append" || plan.name === null)) {
      statusEl.textContent = "本文が空なので保存しない";
      return;
    }
    saveButton.disabled = true;
    statusEl.textContent = "保存中";
    const fail = (reason: string) => {
      statusEl.textContent = `保存できない: ${reason}`;
      saveButton.disabled = false;
    };

    let path: string;
    let url: string;
    // 失敗したときに下書きを戻す。戻さないと、確認画面を離れた後のページ移動で勝手に送られる
    let restore: () => void;
    // 既存のページか、同じタブで書きかけの（まだ保存していない）新しいページなら、その下書きに足す
    const appendTo = plan.kind === "append" ? plan.meta.path : plan.name !== null ? draftForNewPage(plan.name)?.base.path : undefined;
    if (plan.kind === "create" && appendTo === undefined) {
      let dir: string;
      try {
        dir = await deps.pageDir();
      } catch (e) {
        if (!stale(seq)) fail(`新しいページを置く場所を取れない: ${message(e)}`);
        return;
      }
      if (stale(seq)) return;
      const file = allocateNewPageFile(kb, plan.name, dir, new Date());
      const key = plan.name ?? nameOf(file.path);
      // 基準を "" にして最初から変わっている下書きにする（見出しだけでも保存される）
      openNewDraft(key, file.path, "", appendBody(file.content, body));
      path = file.path;
      url = pageUrl(key);
      restore = () => clearDraft(path);
    } else {
      path = appendTo!;
      url = pageUrl(plan.name!);
      let draft = getDraft(path);
      const before = draft?.content;
      if (!draft) {
        const file = await kb.content(path);
        if (stale(seq)) return;
        if (!file) {
          fail("ページを読めない");
          return;
        }
        draft = openDraft(file);
      }
      if (draft.conflict) {
        fail("このページは競合を解決していない");
        return;
      }
      updateDraft(path, appendBody(draft.content, body));
      restore = before === undefined ? () => clearDraft(path) : () => updateDraft(path, before);
    }

    const result = await saver.saveNow(path);
    // 保存中に別のページへ移ったら、以後は普通の下書きと同じ扱い（失敗してもページ移動の保存で送り直す）
    if (stale(seq)) return;
    // 競合なら、そのページの先頭に競合の表示が出る
    if (result.ok || result.conflict !== undefined) {
      router.replace(url);
      return;
    }
    restore();
    fail(result.error ?? "理由は不明");
  };
  saveButton.addEventListener("click", () => void save());
}
