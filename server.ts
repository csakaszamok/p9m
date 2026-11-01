import { appsDomain } from "./services/domains";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { startDeepSleepScheduler } from "./services/deepSleep";
import { startAccessRefresher } from "./services/appAccess/traefik";
import { internalOnly, internalListenAddress, INTERNAL_NETWORK, INTERNAL_PORT } from "./services/appAccess/internal";
import { errorPage, ERROR_PAGE_PATH } from "./services/errorPage";
import { startSessionWatch } from "./services/sessionWatch";
import { startTrafficKeepAlive } from "./services/trafficKeepAlive";
import { openSignInWarning } from "./services/allowlist";
import { insecureConfigWarnings, insecureConfigErrors, hostMountWarnings } from "./services/configWarnings";
import { syncTlsConfig } from "./services/tlsConfig";
import { migrateHostPaths } from "./services/pathMigration";
import { migrateAppsDomain } from "./services/appsDomainMigration";
import { migrateReadOnlyMounts } from "./services/mountMigration";
import { migrateIsolatedNetwork } from "./services/networkMigration";
import { startTcpGateway } from "./services/tcpGateway";
import { resolveTcpHost, resolveDockerHost } from "./services/tcpRoutes";
import { findSandboxDirByHost, primeSablierSession } from "./services/wake";
import { tcpTlsCredentials } from "./services/tcpCert";
import { ensureKeyPair } from "./services/registryAuth";
import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeWebResponse, readBody } from "./services/http";
import { bodyLimit } from "./services/bodyLimit";
import { attachTerminals } from "./services/terminalServer";
import { CLIENT_IP_HEADER, clientAddress } from "./services/loginGuard";
import { getCookie, SESSION_COOKIE, setsSessionCookie, touchedSessionCookie } from "./services/session";
import { startUsageSampler } from "./services/usageSampler";
import { startDiskSampler } from "./services/diskUsage";
import { repoInfo, p9mVersion } from "./services/repoInfo";
import { isHubHost } from "./services/hub/config";
import { handleHub } from "./services/hub/router";
import { mcpCaller, mcpToolsFor } from "./services/mcp";
// From the base image (ghcr.io/csakaszamok/rododentron): the API routes as MCP tools
import { createMcpHandler } from "./mcp-core";
import { defaultRuntime, runtimeAllowed, runtimeMissing } from "./services/defaultRuntime";
import { startRegistryGc } from "./services/registryGc";
import { resumeScans } from "./services/registryScans";
import { notifySecret } from "./services/notifySecret";
import { resourceDefaults } from "./services/resources";

// Supports both old-style handler.ts (handle(req,res)) and
// new-style METHOD.ts (default(req: Request): Promise<Response>)

type OldHandlerModule = {
  handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  openapi?: Record<string, unknown>;
};

type NewHandlerModule = {
  default: (req: Request) => Promise<Response>;
  openapi?: Record<string, unknown>;
};

type HandlerModule = OldHandlerModule | NewHandlerModule;

// --- Dinamikus handler betöltés mtime-alapú cache-sel ---

const cache = new Map<string, { mtime: number; mod: HandlerModule }>();

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

async function loadHandler(routePath: string, method: string): Promise<HandlerModule | null> {
  const base = join(process.cwd(), "routes", routePath);

  // Try method-based file first (GET.ts, POST.ts, etc.)
  const methodFile = join(base, `${method.toUpperCase()}.ts`);
  let stats;
  try { stats = await stat(methodFile); } catch { stats = null; }

  if (stats) {
    const mtime = stats.mtimeMs;
    const cached = cache.get(methodFile);
    if (cached?.mtime === mtime) return cached.mod;
    const mod = await import(pathToFileURL(methodFile).href + `?t=${mtime}`) as HandlerModule;
    cache.set(methodFile, { mtime, mod });
    return mod;
  }

  // Fall back to handler.ts
  const handlerFile = join(base, "handler.ts");
  try { stats = await stat(handlerFile); } catch { return null; }

  const mtime = stats.mtimeMs;
  const cached = cache.get(handlerFile);
  if (cached?.mtime === mtime) return cached.mod;

  const mod = await import(pathToFileURL(handlerFile).href + `?t=${mtime}`) as HandlerModule;
  cache.set(handlerFile, { mtime, mod });
  return mod;
}

// --- Swagger spec generálás ---

async function scanRoutes(dir: string, base = ""): Promise<Array<{ path: string; method: string; file: string }>> {
  const out: Array<{ path: string; method: string; file: string }> = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    if (e.isDirectory()) {
      out.push(...await scanRoutes(join(dir, e.name), `${base}/${e.name}`));
    } else if (e.name === "handler.ts") {
      out.push({ path: base || "/", method: "get", file: join(dir, e.name) });
    } else {
      const match = e.name.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\.ts$/);
      if (match) {
        out.push({ path: base || "/", method: match[1].toLowerCase(), file: join(dir, e.name) });
      }
    }
  }
  return out;
}

async function buildSpec(): Promise<object> {
  const routes = await scanRoutes(join(process.cwd(), "routes"));
  const paths: Record<string, Record<string, unknown>> = {};
  const hasAuth = !!TOKEN;

  for (const { path, method } of routes) {
    const mod = await loadHandler(path.replace(/^\//, "") || "/", method);
    const meta = (mod as { openapi?: Record<string, unknown> })?.openapi ?? {};
    const effectiveMethod = (meta.method as string | undefined) ?? method;

    // Convert [name] folder convention to OpenAPI {name} path parameters
    const openApiPath = path.replace(/\[([^\]]+)\]/g, '{$1}');
    const autoParams = [...openApiPath.matchAll(/\{([^}]+)\}/g)].map(m => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' }
    }));
    const allParams = [...autoParams, ...((meta.parameters as unknown[]) ?? [])];

    if (!paths[openApiPath]) paths[openApiPath] = {};
    paths[openApiPath][effectiveMethod] = {
      summary: (meta.summary as string | undefined) ?? path,
      ...(meta.description ? { description: meta.description } : {}),
      ...(allParams.length > 0 ? { parameters: allParams } : {}),
      ...(meta.requestBody ? { requestBody: meta.requestBody } : {}),
      responses: meta.responses ?? { 200: { description: "OK" } },
      tags: (meta.tags as string[] | undefined) ?? [path.split("/").filter(Boolean)[0] ?? "default"],
      ...(meta.security ? { security: meta.security } : hasAuth ? { security: [{ bearerAuth: [] }] } : {}),
    };
  }

  const apiTitle = process.env.API_TITLE ?? "Rododentron API";
  return {
    openapi: "3.0.0",
    info: { title: apiTitle, version: p9mVersion() ?? "0.0.0" },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    ...(hasAuth ? { security: [{ bearerAuth: [] }] } : {}),
    paths,
  };
}

const SWAGGER_UI = `<!DOCTYPE html>
<html><head><title>Rododentron API</title><meta charset="utf-8">
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head>
<body style="margin:0"><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"/swagger.json",dom_id:"#ui",deepLinking:true,layout:"BaseLayout",persistAuthorization:true})</script>
</body></html>`;

// --- HTTP szerver ---

const TOKEN = process.env.TOKEN;

function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${TOKEN}`) return true;
  const qs = new URL(req.url ?? "/", "http://localhost").searchParams;
  return qs.get("token") === TOKEN;
}

// Convert IncomingMessage to Web API Request
// Read into memory, so capped (services/bodyLimit): 2 MB, the largest Files upload for a signed-in one
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const body = await readBody(req, bodyLimit(req.method ?? "GET", url.pathname, headers));
  // Who is asking, for the sign-in limits: set here, so a client cannot send its own
  const xff = req.headers["x-forwarded-for"];
  headers.set(CLIENT_IP_HEADER, clientAddress(req.socket.remoteAddress, Array.isArray(xff) ? xff.join(", ") : xff));
  return new Request(url.toString(), {
    method: req.method ?? "GET",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });
}

/** A body over the cap (readBody): 413, and the connection closed so the rest is not read. */
function tooLarge(err: unknown, res: ServerResponse): boolean {
  if ((err as { status?: number }).status !== 413 || res.headersSent) return false;
  res.writeHead(413, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify({ error: `Request body too large` }));
  return true;
}

const configErrors = insecureConfigErrors(process.env);
if (configErrors.length) {
  for (const e of configErrors) console.error(`FATAL: ${e}`);
  console.error("FATAL: refusing to start — fix the settings above in .env, then docker compose up -d.");
  process.exit(1);
}
console.log(`[tls] HTTPS ${syncTlsConfig()} (certs/tls.crt + certs/tls.key)`);
// The registry mounts the certificate and the healthcheck waits for it, so on a
// fresh install it has to exist before the first sandbox is created.
ensureKeyPair();
// The registry reads its notification secret from the data dir when it starts
notifySecret();

async function handle(req: IncomingMessage, res: ServerResponse, internal: boolean): Promise<void> {
  let path = (req.url ?? "/").split("?")[0];
  // The forwardAuth and the HTTP provider only on the internal port; nothing else there
  if (internalOnly(path) !== internal) { res.writeHead(404).end("Not Found"); return; }
  const method = req.method ?? "GET";

  if (path.includes("..")) { res.writeHead(400).end("Bad Request"); return; }

  // Traefik's error-page middleware, for any host (a sandbox app's too): it keeps the original 404 status
  if (path === ERROR_PAGE_PATH) {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(await errorPage());
    } catch (err) {
      console.error("[error-page]", err);
      if (!res.headersSent) res.writeHead(500).end("Internal Server Error");
    }
    return;
  }

  // The Hub host: only the Hub's own routes; Purgatorium's API, /mcp and /swagger never answer here
  if (isHubHost(req.headers.host)) {
    try {
      await writeWebResponse(await handleHub(await toWebRequest(req)), res);
    } catch (err) {
      if (tooLarge(err, res)) return;
      console.error("[hub]", err);
      if (!res.headersSent) res.writeHead(500).end("Internal Server Error");
    }
    return;
  }

  if (path === "/swagger") {
    res.writeHead(200, { "Content-Type": "text/html" }).end(SWAGGER_UI);
    return;
  }
  if (path === "/mcp") {
    try {
      const webReq = await toWebRequest(req);
      const caller = mcpCaller(webReq);
      const out = caller instanceof Response ? caller
        // Per request: the tools listed depend on the caller's token
        : await createMcpHandler({ name: "p9m", version: repoInfo().version ?? undefined, include: mcpToolsFor(caller) })(webReq);
      await writeWebResponse(out, res);
    } catch (err) {
      if (tooLarge(err, res)) return;
      console.error("[mcp]", err);
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
    return;
  }
  if (path === "/swagger.json") {
    const spec = await buildSpec();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(spec, null, 2));
    return;
  }

  if (!authorized(req)) { res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized"); return; }

  if (path === "/") path = "/index";

  // Replace [name] dynamic segments: /sandboxes/foo -> /sandboxes/[name]
  // Walk the filesystem to find the matching route
  const routePath = await resolveRoutePath(path);

  try {
    const handler = await loadHandler(routePath, method);
    if (!handler) { res.writeHead(404).end("Not Found"); return; }

    if ("handle" in handler) {
      // Old-style Node.js handler
      await (handler as OldHandlerModule).handle(req, res);
    } else if ("default" in handler) {
      // New-style Web API handler
      const webReq = await toWebRequest(req);
      const webRes = await (handler as NewHandlerModule).default(webReq);
      // Opening a page is doing something: the session's idle time starts again (background polls are not pages)
      if (method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && !setsSessionCookie(webRes.headers.getSetCookie())) {
        const touched = touchedSessionCookie(getCookie(webReq, SESSION_COOKIE));
        // A Response.redirect() has immutable headers: that page is not opened, nothing to renew
        if (touched) try { webRes.headers.append("set-cookie", touched); } catch { /* immutable */ }
      }
      await writeWebResponse(webRes, res);
    } else {
      res.writeHead(500).end("Invalid handler module");
    }
  } catch (err) {
    if (tooLarge(err, res)) return;
    console.error(`Handler hiba [${path}]:`, err);
    if (!res.headersSent) res.writeHead(500).end(String(err));
  }
}
const server = createServer((req, res) => handle(req, res, false));
server.listen(3000, () => console.log("Listening on :3000"));
// Only for Traefik on the internal network (not published, not on traefik-net with the sandboxes' frps and socat): app access
internalListenAddress().then(addr => {
  if (!addr) console.warn(`[internal] WARNING: not on the ${INTERNAL_NETWORK} network: port ${INTERNAL_PORT} listens on every address, so a sandbox can read every sandbox's name and its apps' access levels. Use the docker-compose.yml of this release.`);
  createServer((req, res) => handle(req, res, true)).listen(INTERNAL_PORT, addr ?? undefined, () => console.log(`Listening on ${addr ?? ""}:${INTERNAL_PORT} (internal: app access)`));
});

// Browser terminals: /sandboxes/:name/terminal upgraded to a websocket (checked before the upgrade)
attachTerminals(server);
// TLS-only TCP addresses for sandbox ports: Traefik passes *-tcp.<domain> on :443 through to this.
const tcpPort = Number(process.env.TCP_GATEWAY_PORT ?? 4443);
const tcpCreds = tcpTlsCredentials();
startTcpGateway({
  port: tcpPort, key: tcpCreds.key, cert: tcpCreds.cert, resolve: (sni, signal) => resolveTcpHost(sni, { signal }),
  // <raw>-docker.<domain>: the sandbox's dockerd, TLS passed through untouched (its own CA and client certificates)
  passthrough: {
    match: sni => sni.endsWith(`-docker.${appsDomain()}`),
    resolve: (sni, signal) => resolveDockerHost(sni, { signal }),
    // Docker access does not pass Sablier: renew its session while bytes go through (a build, `docker logs -f`),
    // not for a connection that is only open (Docker Desktop keeps a context connected for its Builds view)
    keepAlive: (sni, lastTraffic) => {
      const sandbox = findSandboxDirByHost(sni);
      return sandbox ? startTrafficKeepAlive(lastTraffic, () => { void primeSablierSession(sandbox, 1); }) : () => {};
    },
  },
})
  .then(() => console.log(`[tcp] gateway on :${tcpPort} (certificate: ${tcpCreds.source})`))
  .catch(err => console.error("[tcp] gateway failed to start:", err));
startDeepSleepScheduler();
// p9m.access of the running sandboxes' apps, read every 10 s (Traefik reads the middlewares every 2 s)
startAccessRefresher();
// A running sandbox without a Sablier session (started outside p9m) would never sleep: open its session
startSessionWatch();
startUsageSampler(10_000);
startDiskSampler();
// The topbar's GitHub star and fork counts: fetched now, so the first page has them
repoInfo();
// OIDC with no OIDC_ALLOWED_DOMAINS / OIDC_ALLOWED_EMAILS (only with OIDC_ALLOW_ANYONE=true): anyone with an account at the provider gets in
{ const open = openSignInWarning(); if (open) console.warn(open); }
// Say once which runtime new sandboxes get, and why dind when sysbox would be safer
void defaultRuntime().then(rt => {
  const auto = !process.env.DEFAULT_RUNTIME || process.env.DEFAULT_RUNTIME === "auto";
  if (auto && rt === "dind") console.warn("[runtime] sysbox is not installed: new sandboxes run privileged (dind), which is for development only. Install sysbox on a Linux host for isolation.");
  else console.log(`[runtime] new sandboxes run on ${rt}${auto ? " (auto)" : ""}`);
  void runtimeMissing(rt).then(missing => { if (missing) console.warn(`[runtime] new sandboxes cannot be created: ${missing}`) });
  if (!runtimeAllowed(rt)) console.warn(`[runtime] the default runtime ${rt} is not in ALLOWED_RUNTIMES: a create without a runtime is refused; set DEFAULT_RUNTIME to an allowed one`);
});
startRegistryGc();
// Scans interrupted by a restart run again (their repos stay private meanwhile)
void resumeScans().catch(err => console.error("[registry] resuming scans:", err));
for (const w of resourceDefaults().warnings) console.warn(`[resources] ${w}`);
// Sandboxes whose install directory was moved or renamed: point their mounts at the current directory; then those
// made under another apps domain (APPS_DOMAIN set or changed): their apps under the current one
migrateHostPaths().catch(err => console.error("[paths] migration failed:", err))
  .then(() => migrateAppsDomain()).catch(err => console.error("[apps-domain] migration failed:", err))
  .then(() => migrateReadOnlyMounts()).catch(err => console.error("[mounts] migration failed:", err))
  .then(() => migrateIsolatedNetwork()).catch(err => console.error("[network] migration failed:", err));
for (const warning of [...insecureConfigWarnings(process.env), ...hostMountWarnings(process.env)]) console.warn(warning);


// --- Dynamic route resolution ---
// Matches /sandboxes/foo/start to routes/sandboxes/[name]/start

async function resolveRoutePath(urlPath: string): Promise<string> {
  const segments = urlPath.replace(/^\//, "").split("/");
  const routesDir = join(process.cwd(), "routes");
  const resolved = await matchSegments(routesDir, segments);
  return resolved ?? urlPath.replace(/^\//, "");
}

async function matchSegments(dir: string, segments: string[]): Promise<string | null> {
  if (segments.length === 0) return "";

  const [head, ...rest] = segments;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }

  // Prefer exact match over dynamic
  const exactMatch = entries.find(e => e.isDirectory() && e.name === head);
  if (exactMatch) {
    const subResult = rest.length === 0
      ? head
      : await matchSegments(join(dir, head), rest).then(r => r !== null ? `${head}/${r}` : null);
    if (subResult !== null) return subResult;
  }

  // Try dynamic segment [name]
  const dynamicMatch = entries.find(e => e.isDirectory() && e.name.startsWith("[") && e.name.endsWith("]"));
  if (dynamicMatch) {
    const dynName = dynamicMatch.name;
    if (rest.length === 0) return dynName;
    const subResult = await matchSegments(join(dir, dynName), rest);
    if (subResult !== null) return `${dynName}/${subResult}`;
  }

  return null;
}
