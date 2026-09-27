// URL とページの対応（SPEC.md「URL」）。history API で遷移し、ページ内の / で始まるリンクのクリックを横取りする

export type Route =
  | { kind: "home" }
  | { kind: "page"; name: string }
  | { kind: "all"; q: string }
  | { kind: "new"; title: string; body: string }
  | { kind: "append"; page: string; body: string }
  | { kind: "unknown"; path: string };

export function parseRoute(pathname: string, search = ""): Route {
  const params = new URLSearchParams(search);
  if (pathname === "/") return { kind: "home" };
  if (pathname.startsWith("/p/")) {
    let name: string;
    try {
      name = decodeURIComponent(pathname.slice(3));
    } catch {
      return { kind: "unknown", path: pathname };
    }
    return name === "" ? { kind: "unknown", path: pathname } : { kind: "page", name };
  }
  if (pathname === "/all") return { kind: "all", q: params.get("q") ?? "" };
  if (pathname === "/new") return { kind: "new", title: params.get("title") ?? "", body: params.get("body") ?? "" };
  if (pathname === "/append") return { kind: "append", page: params.get("page") ?? "", body: params.get("body") ?? "" };
  return { kind: "unknown", path: pathname };
}

export interface Router {
  current(): Route;
  // pushState で遷移して描画する
  navigate(path: string): void;
}

// onRoute は最初と遷移のたびに呼ばれる
export function startRouter(onRoute: (route: Route) => void): Router {
  const current = () => parseRoute(location.pathname, location.search);
  const navigate = (path: string) => {
    if (path === location.pathname + location.search) return;
    history.pushState(null, "", path);
    onRoute(current());
  };
  window.addEventListener("popstate", () => onRoute(current()));
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    // アプリの中の URL だけ。/api/ は Worker の応答をそのまま見せる
    if (!href || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return;
    e.preventDefault();
    navigate(href);
  });
  onRoute(current());
  return { current, navigate };
}
