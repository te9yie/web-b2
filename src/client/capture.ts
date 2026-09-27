// 取り込み（SPEC.md「URL」の /new と /append）。ブックマークレットの受け口。
// 開いただけでは何も書かない。行き先と本文を確認画面で見せ、「保存」を押したときに書く
// （DECISIONS.md 2026-09-28「/new と /append は確認画面で「保存」を押してから書く」）。
// 本文は Markdown として描かず、<textarea> の文字として見せる（HTML を消毒しない表示なので、描くと確認画面でスクリプトが動く）。
// 保存は編集と同じ下書きと Saver で行う

import { clearDraft, draftForNewPage, getDraft, isDirty, normalizeEol, openDraft, openNewDraft, updateDraft } from "./drafts";
import type { Kb } from "./kb";
import { type KbIndex, refName } from "./kb-index";
import { type PageMeta, nameOf, parsePage } from "./page";
import { pageUrl } from "./render";
import type { Route, Router } from "./router";
import type { Saver } from "./saver";
import { SETTINGS_NAME } from "./settings";
import { allocateNewPageFile, newPageFile, stale, whenSynced } from "./view";

export type CaptureRoute = Extract<Route, { kind: "new" | "append" }>;

// 「保存」を押せるようにするまでの待ち。ページがフォーカスを得てから（見える状態になってから）この時間は押させない
// （DECISIONS.md 2026-09-28「取り込みの「保存」は、ページがフォーカスを得てから500ms経つまで押せない」）
export const ARM_DELAY = 500;

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

// URL の中で使われうる名前つきの実体参照。ほかの名前は戻さない
const NAMED_ENTITIES: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", nbsp: " ", lpar: "(", rpar: ")", sol: "/" };

function fromCodePoint(n: number): string {
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

// 実体参照を文字に戻す。数値のものは ; を省いてもブラウザが戻すので、; はなくてもよい
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

// Markdown の記号の前の \ を外す（marked はリンクの行き先の `javascript\:` を `javascript:` に戻して href に書く）
function unescapeMarkdown(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

// リンクとして読まれうる行き先。インラインのリンク（`](` の後ろ）、参照の定義の行（`[x]: ...`）、自動リンク（`<...>`）、
// HTML の href=・src= の後ろ。行き先の中の実体参照は、取り出してから戻す（戻す前に取り出さないと、&#41; などで区切りがずれる）
function linkDestinations(s: string): string[] {
  const t = unescapeMarkdown(s);
  const found: string[] = [];
  for (const m of t.matchAll(/\]\(\s*<?([^)\n]*)/g)) found.push(m[1]);
  for (const m of t.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*<?(\S*)/gm)) found.push(m[1]);
  for (const m of t.matchAll(/<([a-z][a-z0-9+.-]*:[^>\s]*)>/gi)) found.push(m[1]);
  for (const m of t.matchAll(/(?:href|src)\s*=\s*["']?([^"'\s>]*)/gi)) found.push(m[1]);
  return found;
}

// 行き先が javascript: の URL か。ブラウザは URL の空白と制御文字を除いて読むので、除いてから見る
function isScriptUrl(dest: string): boolean {
  return /^javascript:/i.test(decodeEntities(dest).replace(/[\s\u0000-\u001f\u007f]/g, ""));
}

// 本文が HTML を含むか、リンクの行き先に javascript: を含むか（注意に使う）。`a < b` のような比較は当たらない。
// javascript: はリンクの行き先だけで探すので、「JavaScript: The Good Parts を読んだ」のような文には当たらない
export function looksLikeHtml(s: string): boolean {
  if (/<[a-z!/]/i.test(s) || /\son[a-z]+\s*=/i.test(s)) return true;
  return linkDestinations(s).some(isScriptUrl);
}

// 見出しとして描くと HTML かリンクになる形。見つかった文字を返す。
// `<` の後ろに英字か ! / ?（タグ、コメント、自動リンク）、`](`・`][`・`]:`（リンクと参照の書き方）、on...= の属性。
// javascript: そのものは見ない（見出しの中で動くのはリンクの行き先に入ったときだけで、その形はリンクの書き方で止まる）
const HEADING_HAZARDS = [/<[a-z!/?]/i, /\][(\[:]/, /\bon[a-z]+\s*=/i];

export function headingHazard(name: string): string | null {
  for (const re of HEADING_HAZARDS) {
    const m = re.exec(name);
    if (m) return m[0];
  }
  return null;
}

// 新しいページの見出し（# name）にできない理由。なければ null。
// HTML やリンクになる形は見出しとして描くとそのまま動く。見出しから読み直した title が name と違うと、保存したページを name で引けず、
// 同じ title の二度目の取り込みで同じ見出しのページがもう一つできる
export function headingProblem(name: string, content = newPageFile(name, "", new Date()).content): string | null {
  const hazard = headingHazard(name);
  if (hazard !== null) return `タイトルの「${hazard}」は見出しとして描くと HTML かリンクになるので、見出しにできない`;
  if (refName(name) !== name || parsePage({ path: "capture.md", content }).title !== name) {
    return "タイトルを見出しにすると別の文字として読まれるので、ページを引けない";
  }
  return null;
}

// 行き先。索引だけを見て決める（差分の同期の後に呼ぶ）。settings は行き先が settings ページか
export type CapturePlan =
  // 新しいページを作る。name が null なら title なし（時刻のファイル名、見出しなし）
  | { kind: "create"; name: string | null; settings: boolean }
  // 既存のページの末尾に足す。name は解決した name
  | { kind: "append"; name: string; meta: PageMeta; settings: boolean }
  // 保存できない。name があれば、そのページへのリンクを添える。heading は見出しにできない title（確認画面で直せる）
  | { kind: "invalid"; reason: string; name?: string; heading?: true };

// name を見出しにして新しいページを作る。見出しにできなければ invalid
function createPlan(name: string): CapturePlan {
  const problem = headingProblem(name);
  if (problem !== null) return { kind: "invalid", reason: problem, heading: true };
  return { kind: "create", name, settings: name === SETTINGS_NAME };
}

export function planCapture(index: KbIndex, route: CaptureRoute): CapturePlan {
  const body = normalizeBody(route.body);
  const settingsName = index.resolve(SETTINGS_NAME)?.[0] ?? null;
  if (route.kind === "new") {
    // /append の page と同じく [[ ]] を外す（resolve も外してから引くので、外さないと保存したページを引けない）
    const title = refName(captureTitle(route.title) ?? "");
    if (title === "") {
      return isBlank(body) ? { kind: "invalid", reason: "title も body もない" } : { kind: "create", name: null, settings: false };
    }
    const found = index.resolve(title);
    if (!found) return createPlan(title);
    // 同じ名前のページを新しく作らず、そのページへの追記にする（DECISIONS.md 2026-09-28）
    if (isBlank(body)) return { kind: "invalid", reason: "同じ名前のページがある", name: found[0] };
    return { kind: "append", name: found[0], meta: found[1], settings: found[0] === settingsName };
  }
  const page = refName(captureTitle(route.page) ?? "");
  if (page === "") return { kind: "invalid", reason: "page がない" };
  if (isBlank(body)) return { kind: "invalid", reason: "body がない", name: index.resolve(page)?.[0] };
  const found = index.resolve(page);
  if (!found) return createPlan(page);
  return { kind: "append", name: found[0], meta: found[1], settings: found[0] === settingsName };
}

// 注意の文。保存は止めない。target は行き先が決まってから渡す（content は追記するときの既存の中身）
export function captureWarnings(body: string, target: { settings: boolean; content: string | null } | null = null): string[] {
  const warnings: string[] = [];
  if (looksLikeHtml(body)) warnings.push("本文に HTML が含まれている。保存すると、表示のときにそのまま動く（スクリプトも）");
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
  root.innerHTML = `<article class="capture"><h1></h1><p class="capture-target"></p><label class="capture-title-label" hidden>タイトル<input class="capture-title" type="text" autocomplete="off"></label><ul class="capture-warnings"></ul><label>本文<textarea class="capture-body" rows="12"></textarea></label><pre class="capture-tail" hidden></pre><p class="capture-status"></p><p class="capture-hint"></p><div class="choices"><button type="button" class="save" disabled>保存</button><button type="button" class="cancel">やめる</button></div></article>`;
  setHeading(route.kind === "append");
  const targetEl = root.querySelector<HTMLElement>(".capture-target")!;
  const titleLabel = root.querySelector<HTMLElement>(".capture-title-label")!;
  const titleInput = root.querySelector<HTMLInputElement>(".capture-title")!;
  const warningsEl = root.querySelector<HTMLElement>(".capture-warnings")!;
  const textarea = root.querySelector<HTMLTextAreaElement>(".capture-body")!;
  const tailEl = root.querySelector<HTMLElement>(".capture-tail")!;
  const statusEl = root.querySelector<HTMLElement>(".capture-status")!;
  const hintEl = root.querySelector<HTMLElement>(".capture-hint")!;
  const saveButton = root.querySelector<HTMLButtonElement>("button.save")!;
  const cancelButton = root.querySelector<HTMLButtonElement>("button.cancel")!;
  cancelButton.addEventListener("click", () => router.replace("/"));
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

  // 「保存」を押せるのは、行き先が決まり（ready）、保存中でなく、ページがフォーカスを持って見えていて、
  // 最後にフォーカスを得てから（見える状態になってから）ARM_DELAY 経ったとき。
  // 別のサイトが二度押しを促し、1回目で隠しておいたこの窓を前に出して2回目を「保存」に当てさせる手口を防ぐ。
  // 保存中は「やめる」も押させない（押すと、失敗した下書きが戻されないまま後のページ移動で送られる）
  let ready = false;
  let saving = false;
  let armedAt = performance.now();
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  const isFocused = () => document.hasFocus() && document.visibilityState === "visible";
  let wasFocused = isFocused();
  const refresh = () => {
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
    if (stale(seq)) {
      detach();
      return;
    }
    const focused = isFocused();
    // focus のイベントを取りこぼしても、フォーカスを得たところから数え直す
    if (focused && !wasFocused) armedAt = performance.now();
    wasFocused = focused;
    const elapsed = performance.now() - armedAt;
    cancelButton.disabled = saving;
    titleInput.disabled = saving;
    saveButton.disabled = !(ready && !saving && focused && elapsed >= ARM_DELAY);
    const waiting = saveButton.disabled && saveButton.isConnected && ready && !saving;
    // フォーカスがないせいで押せないときは、そう出す（別の窓から戻って押しても、最初の1回は数え直しになって効かない）
    hintEl.textContent = waiting && !focused ? "このページを前に出すと、少しして保存できる" : "";
    // 押せるようになるまで見直す。フォーカスがないあいだは、イベントが来なくても気づけるよう短い間隔で見る
    if (waiting) armTimer = setTimeout(refresh, focused ? ARM_DELAY - elapsed : 200);
  };
  const rearm = () => {
    armedAt = performance.now();
    refresh();
  };
  const onVisibility = () => (document.visibilityState === "visible" ? rearm() : refresh());
  const detach = () => {
    window.removeEventListener("focus", rearm);
    window.removeEventListener("blur", refresh);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  window.addEventListener("focus", rearm);
  window.addEventListener("blur", refresh);
  document.addEventListener("visibilitychange", onVisibility);

  // 保存できないと決まったら「保存」を消し、理由を出す（「やめる」だけ残す）
  const stop = (...parts: (string | Node)[]) => {
    ready = false;
    saving = false;
    saveButton.remove();
    titleLabel.hidden = true;
    detach();
    cancelButton.disabled = false;
    hintEl.textContent = "";
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
  if (stale(seq)) {
    detach();
    return;
  }
  if (!synced.ok) {
    stop(`差分を取れないので保存できない: ${synced.error}。再読み込みで試し直す`);
    return;
  }

  // 行き先を決めて出す。見出しにできない title なら、title を直す欄を出し、直すたびに決め直す
  // （DECISIONS.md 2026-09-28「/new と /append は確認画面で「保存」を押してから書く」）
  let plan: Exclude<CapturePlan, { kind: "invalid" }> | null = null;
  // title を直す欄を出したか。出した後は、保存できない理由があっても「保存」を消さず、押せないままにする
  let editing = false;
  let decision = 0;
  const block = (...parts: (string | Node)[]) => {
    if (!editing) {
      stop(...parts);
      return;
    }
    ready = false;
    saving = false;
    refresh();
    statusEl.replaceChildren(...parts);
  };
  const decide = async (r: CaptureRoute): Promise<void> => {
    const mine = ++decision;
    ready = false;
    plan = null;
    target = null;
    extra = [];
    tailEl.hidden = true;
    tailEl.textContent = "";
    statusEl.textContent = "";
    refresh();
    const p = planCapture(kb.index, r);
    if (p.kind === "invalid") {
      setHeading(route.kind === "append");
      targetEl.textContent = p.reason;
      if (p.name !== undefined) targetEl.append("（", pageLink(p.name, kb.index.get(p.name)?.title ?? p.name), "）");
      if (p.heading && !editing) {
        editing = true;
        // 行き先と同じく空白と改行を1つの空白にまとめて入れる（input は改行を消すので、そのままだと語が詰まる）
        titleInput.value = captureTitle(r.kind === "new" ? r.title : r.page) ?? "";
        titleLabel.hidden = false;
        titleInput.addEventListener("input", () => {
          const v = titleInput.value;
          void decide(route.kind === "new" ? { ...route, title: v } : { ...route, page: v });
        });
      }
      showWarnings();
      if (editing) block("タイトルを直すと保存できる");
      else stop();
      return;
    }
    if (p.kind === "create") {
      setHeading(route.kind === "append");
      targetEl.textContent = p.name === null ? "タイトルのない新しいページを作る" : `新しいページ「${p.name}」を作る`;
      target = { settings: p.settings, content: null };
    } else {
      setHeading(true);
      targetEl.replaceChildren(r.kind === "new" ? "同じ名前のページがある。" : "", "「", pageLink(p.name, p.meta.title), "」の末尾に足す");
      const draft = getDraft(p.meta.path);
      if (draft?.conflict) {
        block("このページは競合を解決していない。先にページで解決する: ", pageLink(p.name, p.meta.title));
        return;
      }
      const raw = draft?.content ?? (await kb.content(p.meta.path))?.content;
      if (stale(seq)) {
        detach();
        return;
      }
      if (mine !== decision) return;
      if (raw === undefined) {
        block("ページを読めない");
        return;
      }
      const content = normalizeEol(raw);
      if (draft && isDirty(draft)) extra = ["保存していない下書きがあり、一緒に保存される"];
      tailEl.textContent = lastLines(content, 10);
      tailEl.hidden = false;
      target = { settings: p.settings, content };
    }
    showWarnings();
    plan = p;
    ready = true;
    refresh();
  };
  await decide(route);

  const save = async () => {
    refresh();
    const p = plan;
    if (saveButton.disabled || p === null) return;
    const body = normalizeBody(textarea.value);
    // 見出しだけの新しいページ（title のある /new）のほかは、本文がなければ書くものがない
    if (isBlank(body) && (p.kind === "append" || p.name === null)) {
      statusEl.textContent = "本文が空なので保存しない";
      return;
    }
    saving = true;
    refresh();
    statusEl.textContent = "保存中";
    const fail = (reason: string) => {
      saving = false;
      refresh();
      statusEl.textContent = `保存できない: ${reason}`;
    };

    let path: string;
    let url: string;
    // 失敗したときに下書きを戻す。戻さないと、確認画面を離れた後のページ移動で勝手に送られる
    let restore: () => void;
    // 既存のページか、同じタブで書きかけの（まだ保存していない）新しいページなら、その下書きに足す
    const appendTo = p.kind === "append" ? p.meta.path : p.name !== null ? draftForNewPage(p.name)?.base.path : undefined;
    if (p.kind === "create" && appendTo === undefined) {
      let dir: string;
      try {
        dir = await deps.pageDir();
      } catch (e) {
        if (!stale(seq)) fail(`新しいページを置く場所を取れない: ${message(e)}`);
        return;
      }
      if (stale(seq)) return;
      const file = allocateNewPageFile(kb, p.name, dir, new Date());
      const key = p.name ?? nameOf(file.path);
      const content = appendBody(file.content, body);
      // 書く中身から読み直した title が行き先の鍵と同じでなければ、保存したページを鍵で引けない
      const problem = p.name === null ? null : headingProblem(p.name, content);
      if (problem !== null) {
        block(problem);
        return;
      }
      // 基準を "" にして最初から変わっている下書きにする（見出しだけでも保存される）
      openNewDraft(key, file.path, "", content);
      path = file.path;
      url = pageUrl(key);
      restore = () => clearDraft(path);
    } else {
      path = appendTo!;
      url = pageUrl(p.name!);
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
    // 保存中は「やめる」を押せないが、ヘッダーのリンクなどで別のページへ移ることはできる。
    // そのときは、以後は普通の下書きと同じ扱い（失敗してもページ移動の保存で送り直す）
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
