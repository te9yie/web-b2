// `npm run dev:local` で、Viteの開発サーバーの /api/* にローカルモードのAPIをつなぐ。
// SPAとAPIが同じポートに載るので、プロキシを立てずにWorkerと同じURLで動く。
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { createLocalApi } from "./local.ts";

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function localApi(): Plugin {
  return {
    name: "web-b2-local-api",
    configureServer(server) {
      const root = resolve(process.env.KB_ROOT || "fixtures");
      const dir = process.env.KB_DIR || "notes";
      const api = createLocalApi({ root, dir });
      server.config.logger.info(`  ローカルモード: ${root} の ${dir} を読み書きする`);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        toRequest(req)
          .then(api)
          .then((response) => send(res, response))
          .catch(next);
      });
    },
  };
}
