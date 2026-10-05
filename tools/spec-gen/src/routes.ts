/**
 * Phase 1: route discovery and mount-prefix resolution.
 *
 * Builds a graph of express()/Router() instantiation sites ("origins"), the
 * mount edges between them (`X.use(prefix, Y)` and `X.use(Y)`), and every
 * `X.method(path, ...middlewares, handler)` registration found anywhere in
 * the backend source. Origins reached only through function parameters
 * (the `registerXRoutes(app, deps)` pattern, including nested chains such as
 * `registerManagerRoutes` -> `registerCronRoutes`) are resolved by finding the
 * real call sites of the enclosing function via the language service, so a
 * parameter is treated as an alias for whatever origin was actually passed in
 * at each call site — this also correctly disambiguates two functions that
 * share a name in different files (e.g. two `registerTailscaleRoutes`),
 * because resolution follows the bound symbol, never the identifier text.
 *
 * See tools/spec-gen/docs/spec-generation-strategy.md, Phase 1.
 */

import { Node, Project, SourceFile, SyntaxKind } from "ts-morph";
import type { RouteRecord, RoutesIR, ServiceInfo, UnresolvedRoute } from "./types.js";
import { relFile } from "./project.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "all"] as const;
type MethodName = (typeof HTTP_METHODS)[number];

interface OriginNode {
  key: string;
  kind: "app" | "router";
  file: string;
  line: number;
  varName: string;
}

interface RawRoute {
  originKey: string;
  origin: OriginNode;
  method: RouteRecord["method"];
  pathSegment: string | null;
  pathText: string;
  middlewares: string[];
  handlerKind: RouteRecord["handlerKind"];
  file: string;
  line: number;
  anyMethod: boolean;
  /** Groups siblings that came from the same call site's array-literal path. */
  callSiteId: string;
  handlerNode: Node;
  callNode: Node;
}

interface ServicesConfig {
  [relFilePath: string]: { service: string; port: number };
}

export interface RoutesDiscoveryResult {
  ir: RoutesIR;
  /** In-memory handle to each route's handler + call-site AST nodes, for Phases 2-4 in this same run. */
  handlerIndex: Map<string, { handler: Node; call: Node }>;
}

export function discoverRoutes(
  project: Project,
  repoPath: string,
  servicesConfig: ServicesConfig,
): RoutesDiscoveryResult {
  const originMemo = new Map<string, OriginNode[]>();
  const originsByKey = new Map<string, OriginNode>();
  /** target origin key -> incoming mount edges */
  const mountEdgesByTarget = new Map<string, { from: OriginNode; prefix: string }[]>();
  const rawRoutes: RawRoute[] = [];
  const unresolved: UnresolvedRoute[] = [];

  function toRel(absPath: string): string {
    return relFile(repoPath, absPath);
  }

  function makeOrigin(node: Node, kind: "app" | "router", varName: string): OriginNode {
    const file = toRel(node.getSourceFile().getFilePath());
    const line = node.getStartLineNumber();
    const key = `${file}:${line}:${node.getPos()}`;
    let origin = originsByKey.get(key);
    if (!origin) {
      origin = { key, kind, file, line, varName };
      originsByKey.set(key, origin);
    }
    return origin;
  }

  function dedupeOrigins(nodes: OriginNode[]): OriginNode[] {
    const seen = new Map<string, OriginNode>();
    for (const n of nodes) seen.set(n.key, n);
    return [...seen.values()];
  }

  /**
   * Termix 2.9 plugin support. A plugin's backend lives under
   * `plugins/<id>/src/backend/` and is mounted by the plugin host at
   * `/plugin-api/<id>` (HTTP) — a runtime mount that never appears as an
   * in-source `app.use(...)`, so Phase 1 has to synthesize it.
   */
  function pluginIdForFile(file: string): string | null {
    const match = /^plugins\/([^/]+)\//.exec(file);
    return match ? match[1] : null;
  }

  const pluginAppOrigins = new Map<string, OriginNode>();
  function pluginAppOrigin(pluginId: string): OriginNode {
    const key = `plugin-host:${pluginId}`;
    let origin = pluginAppOrigins.get(key);
    if (!origin) {
      origin = {
        key,
        kind: "app",
        file: `plugins/${pluginId}/__plugin_host__.ts`,
        line: 0,
        varName: `plugin(${pluginId})`,
      };
      pluginAppOrigins.set(key, origin);
    }
    return origin;
  }

  /** Resolves any expression to the express()/Router() instantiation site(s) it ultimately refers to. */
  function resolveOrigin(exprIn: Node, depth = 0): OriginNode[] {
    if (depth > 40) return []; // runaway guard
    let expr: Node = exprIn;
    while (Node.isParenthesizedExpression(expr)) expr = expr.getExpression();

    const memoKey = `${expr.getSourceFile().getFilePath()}:${expr.getPos()}`;
    const cached = originMemo.get(memoKey);
    if (cached) return cached;
    originMemo.set(memoKey, []); // cycle guard while resolving

    const result = resolveOriginUncached(expr, depth);
    originMemo.set(memoKey, result);
    return result;
  }

  function resolveOriginUncached(expr: Node, depth: number): OriginNode[] {
    if (Node.isCallExpression(expr)) {
      const callee = expr.getExpression();
      if (Node.isIdentifier(callee) && callee.getText() === "express" && expr.getArguments().length === 0) {
        return [makeOrigin(expr, "app", "express()")];
      }
      if (Node.isIdentifier(callee) && callee.getText() === "Router") {
        return [makeOrigin(expr, "router", "Router()")];
      }
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === "Router") {
        return [makeOrigin(expr, "router", `${callee.getText()}()`)];
      }
      // Termix 2.9 plugins receive their express Router from the host via
      // `ctx.http.router<Router>()` (also called with an options object, e.g.
      // `ctx.http.router<Router>({ bodyLimit: "1gb" })`). Treat it as a router origin.
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === "router") {
        return [makeOrigin(expr, "router", `${callee.getText()}()`)];
      }
      return [];
    }

    if (Node.isIdentifier(expr)) {
      const symbol = expr.getSymbol();
      if (!symbol) return [];
      let resolved = symbol;
      for (let i = 0; i < 10; i++) {
        const aliased = resolved.getAliasedSymbol();
        if (!aliased) break;
        resolved = aliased;
      }
      const decls = resolved.getDeclarations();
      const out: OriginNode[] = [];
      for (const decl of decls) out.push(...resolveDeclaration(decl, depth + 1));
      return dedupeOrigins(out);
    }

    return [];
  }

  function resolveDeclaration(decl: Node, depth: number): OriginNode[] {
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      return init ? resolveOrigin(init, depth) : [];
    }
    if (Node.isExportAssignment(decl)) {
      return resolveOrigin(decl.getExpression(), depth);
    }
    if (decl.getKind() === SyntaxKind.Parameter) {
      return resolveParamOrigin(decl.asKindOrThrow(SyntaxKind.Parameter), depth);
    }
    return [];
  }

  /** Resolves a function parameter by finding real call sites and following the matching argument. */
  function resolveParamOrigin(param: Node, depth: number): OriginNode[] {
    const fn = param.getParent();
    if (!fn || !Node.isFunctionDeclaration(fn)) return [];
    const paramIndex = fn.getParameters().findIndex((p) => p === param);
    if (paramIndex < 0) return [];
    const nameNode = fn.getNameNode();
    if (!nameNode) return [];

    const out: OriginNode[] = [];
    for (const ref of nameNode.findReferencesAsNodes()) {
      const call = ref.getParentIfKind(SyntaxKind.CallExpression);
      if (!call) continue;
      if (call.getExpression() !== ref) continue; // must be in callee position
      const arg = call.getArguments()[paramIndex];
      if (!arg) continue;
      out.push(...resolveOrigin(arg, depth + 1));
    }
    return dedupeOrigins(out);
  }

  // ---- string-literal / path resolution (separate from origin resolution) ----

  /**
   * Resolves a string-valued expression to every value it can actually take, not just one.
   * This matters beyond string literals and simple aliases: a template-literal path segment
   * can depend on a destructured parameter with a default (`{ pathPrefix = "metrics" }`),
   * and when the enclosing function is called from *multiple* call sites — some overriding
   * it, some not — each call site is a genuinely separate route registration from the same
   * source statement. Confirmed case: `registerHostMetricsViewerRoutes` is called once
   * directly (giving `/metrics/heartbeat` etc. from the untouched default) and once wrapped
   * by `registerProxmoxStatsRoutes`, which overrides `pathPrefix` to `"proxmox-stats"`
   * (giving `/proxmox-stats/heartbeat` etc.) — both are real routes; resolving to just one
   * value here silently drops the other. An empty array means "could not resolve at all".
   */
  function resolveStringLiteral(exprIn: Node, depth = 0): string[] {
    if (depth > 40) return [];
    let expr: Node = exprIn;
    while (Node.isParenthesizedExpression(expr)) expr = expr.getExpression();

    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
      return [expr.getLiteralText()];
    }
    if (Node.isTemplateExpression(expr)) {
      let candidates = [expr.getHead().getLiteralText()];
      for (const span of expr.getTemplateSpans()) {
        const resolved = resolveStringLiteral(span.getExpression(), depth + 1);
        if (resolved.length === 0) return [];
        const tail = span.getLiteral().getLiteralText();
        candidates = candidates.flatMap((prefix) => resolved.map((r) => prefix + r + tail));
      }
      return candidates;
    }
    if (Node.isIdentifier(expr)) {
      const symbol = expr.getSymbol();
      if (!symbol) return [];
      let resolved = symbol;
      for (let i = 0; i < 10; i++) {
        const aliased = resolved.getAliasedSymbol();
        if (!aliased) break;
        resolved = aliased;
      }
      const out: string[] = [];
      for (const decl of resolved.getDeclarations()) {
        if (Node.isVariableDeclaration(decl)) {
          const init = decl.getInitializer();
          if (init) out.push(...resolveStringLiteral(init, depth + 1));
        } else if (Node.isBindingElement(decl)) {
          out.push(...resolveBindingElementFromCallSites(decl, depth + 1));
        } else if (decl.getKind() === SyntaxKind.Parameter) {
          const paramDecl = decl.asKindOrThrow(SyntaxKind.Parameter);
          const init = paramDecl.getInitializer();
          if (init) out.push(...resolveStringLiteral(init, depth + 1));
        }
      }
      return [...new Set(out)];
    }
    return [];
  }

  /**
   * For a destructured `{ pathPrefix = "x" }` parameter: one value per call site of the
   * enclosing function — the value that call site's object literal passes for this
   * property, or the parameter's own default when that call site doesn't override it.
   */
  function resolveBindingElementFromCallSites(bindingEl: Node, depth: number): string[] {
    const be = bindingEl.asKindOrThrow(SyntaxKind.BindingElement);
    const propName = be.getPropertyNameNode()?.getText() ?? be.getName();
    const defaultInit = be.getInitializer();
    const defaultValues = defaultInit ? resolveStringLiteral(defaultInit, depth + 1) : [];

    let owner: Node | undefined = be;
    while (owner && owner.getKind() !== SyntaxKind.Parameter) owner = owner.getParent();
    if (!owner) return defaultValues;
    const param = owner.asKindOrThrow(SyntaxKind.Parameter);
    const fn = param.getParent();
    if (!fn || !Node.isFunctionDeclaration(fn)) return defaultValues;
    const paramIndex = fn.getParameters().findIndex((p) => p === param);
    const nameNode = fn.getNameNode();
    if (!nameNode) return defaultValues;

    const out: string[] = [];
    for (const ref of nameNode.findReferencesAsNodes()) {
      const call = ref.getParentIfKind(SyntaxKind.CallExpression);
      if (!call || call.getExpression() !== ref) continue;
      const arg = call.getArguments()[paramIndex];
      let overridden: string[] | undefined;
      if (arg && Node.isObjectLiteralExpression(arg)) {
        for (const prop of arg.getProperties()) {
          if (Node.isPropertyAssignment(prop) && prop.getName() === propName) {
            const init = prop.getInitializer();
            overridden = init ? resolveStringLiteral(init, depth + 1) : [];
            break;
          }
        }
      }
      out.push(...(overridden ?? defaultValues));
    }
    return out.length > 0 ? [...new Set(out)] : defaultValues;
  }

  function isPathExpression(expr: Node): boolean {
    return (
      Node.isStringLiteral(expr) ||
      Node.isNoSubstitutionTemplateLiteral(expr) ||
      Node.isTemplateExpression(expr) ||
      Node.isArrayLiteralExpression(expr)
    );
  }

  /** One entry per syntactic path candidate (array-literal element, or the sole expression);
   *  each entry is that candidate's resolved fan-out (empty = unresolved). */
  function resolvePathCandidates(expr: Node): string[][] {
    if (Node.isArrayLiteralExpression(expr)) {
      return expr.getElements().map((el) => resolveStringLiteral(el));
    }
    return [resolveStringLiteral(expr)];
  }

  function classifyHandlerKind(node: Node): RouteRecord["handlerKind"] {
    if (Node.isArrowFunction(node)) return "inline-arrow";
    if (Node.isFunctionExpression(node)) return "inline-function";
    if (Node.isIdentifier(node)) return "named-function";
    return "property-handler";
  }

  function addMountEdge(from: OriginNode, to: OriginNode, prefix: string): void {
    if (from.key === to.key) return;
    const list = mountEdgesByTarget.get(to.key) ?? [];
    if (!list.some((e) => e.from.key === from.key && e.prefix === prefix)) {
      list.push({ from, prefix });
    }
    mountEdgesByTarget.set(to.key, list);
  }

  function addRawRoute(r: RawRoute): void {
    rawRoutes.push(r);
  }

  // ---- traversal ----

  function handleUseCall(call: Node, objectOrigins: OriginNode[]): void {
    if (!Node.isCallExpression(call)) return;
    const args = call.getArguments();
    if (args.length === 0) return;
    const first = args[0];
    const pathLike = isPathExpression(first);
    const callSiteId = `${toRel(call.getSourceFile().getFilePath())}:${call.getStart()}`;

    if (!pathLike) {
      // X.use(something) — either a bare router/app mount, or unrelated global middleware.
      const targets = resolveOrigin(first);
      if (targets.length > 0) {
        for (const from of objectOrigins) for (const to of targets) addMountEdge(from, to, "");
      }
      return;
    }

    const rest = args.slice(1);
    if (rest.length === 0) return; // X.use("/path") alone is not meaningful, ignore
    const last = rest[rest.length - 1];
    const targets = resolveOrigin(last);
    const pathCandidates = resolvePathCandidates(first);

    if (targets.length > 0) {
      for (const candidate of pathCandidates) {
        for (const p of candidate) {
          for (const from of objectOrigins) for (const to of targets) addMountEdge(from, to, p);
        }
      }
      return;
    }

    // Catch-all method route: X.use("/path", ...middlewares, handlerFn)
    const middlewares = rest.slice(0, -1).map((m) => m.getText());
    const handlerKind = classifyHandlerKind(last);
    const loc = { file: toRel(call.getSourceFile().getFilePath()), line: call.getStartLineNumber() };
    for (const candidate of pathCandidates) {
      if (candidate.length === 0) {
        unresolved.push({
          file: loc.file,
          line: loc.line,
          reason: "could not resolve string literal for X.use() catch-all path",
          snippet: call.getText().slice(0, 200),
        });
        continue;
      }
      for (const p of candidate) {
        for (const origin of objectOrigins) {
          addRawRoute({
            originKey: origin.key,
            origin,
            method: "*",
            pathSegment: p,
            pathText: first.getText(),
            middlewares,
            handlerKind,
            file: loc.file,
            line: loc.line,
            anyMethod: true,
            callSiteId,
            handlerNode: last,
            callNode: call,
          });
        }
      }
    }
  }

  function handleMethodCall(call: Node, method: MethodName, objectOrigins: OriginNode[]): void {
    if (!Node.isCallExpression(call)) return;
    const args = call.getArguments();
    if (args.length === 0) return;
    const pathArg = args[0];
    if (!isPathExpression(pathArg)) return;
    const rest = args.slice(1);
    if (rest.length === 0) return;
    const handler = rest[rest.length - 1];
    const middlewares = rest.slice(0, -1).map((m) => m.getText());
    const handlerKind = classifyHandlerKind(handler);
    const pathCandidates = resolvePathCandidates(pathArg);
    const loc = { file: toRel(call.getSourceFile().getFilePath()), line: call.getStartLineNumber() };
    const callSiteId = `${loc.file}:${call.getStart()}`;
    const httpMethod = method.toUpperCase() as RouteRecord["method"];

    for (const candidate of pathCandidates) {
      if (candidate.length === 0) {
        unresolved.push({
          file: loc.file,
          line: loc.line,
          reason: `could not resolve string literal for ${method}() path`,
          snippet: call.getText().slice(0, 200),
        });
        continue;
      }
      for (const p of candidate) {
        for (const origin of objectOrigins) {
          addRawRoute({
            originKey: origin.key,
            origin,
            method: httpMethod,
            pathSegment: p,
            pathText: pathArg.getText(),
            middlewares,
            handlerKind,
            file: loc.file,
            line: loc.line,
            anyMethod: false,
            callSiteId,
            handlerNode: handler,
            callNode: call,
          });
        }
      }
    }
  }

  function visitFile(sf: SourceFile): void {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const methodName = callee.getName();
      const objectExpr = callee.getExpression();

      if (methodName === "use") {
        const objectOrigins = resolveOrigin(objectExpr);
        if (objectOrigins.length === 0) continue;
        handleUseCall(call, objectOrigins);
        continue;
      }
      if ((HTTP_METHODS as readonly string[]).includes(methodName)) {
        const objectOrigins = resolveOrigin(objectExpr);
        if (objectOrigins.length === 0) continue;
        handleMethodCall(call, methodName as MethodName, objectOrigins);
      }
    }
  }

  const backendFiles = project
    .getSourceFiles()
    .filter((sf) => {
      const rel = toRel(sf.getFilePath());
      return rel.startsWith("src/backend/") || rel.startsWith("plugins/");
    });

  for (const sf of backendFiles) visitFile(sf);

  // ---- prefix resolution: BFS/DFS over mount edges from each origin up to an app root ----

  function findPortInFile(sf: SourceFile | undefined): number | null {
    if (!sf) return null;
    for (const varDecl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = varDecl.getName();
      if (name !== "PORT" && name !== "HTTP_PORT") continue;
      const init = varDecl.getInitializer();
      if (init && Node.isNumericLiteral(init)) return Number(init.getText());
    }
    return null;
  }

  const serviceInfoByFile = new Map<string, ServiceInfo>();
  function serviceInfoFor(appOrigin: OriginNode): ServiceInfo {
    const existing = serviceInfoByFile.get(appOrigin.file);
    if (existing) return existing;
    const pluginId = pluginIdForFile(appOrigin.file);
    if (pluginId) {
      // Plugin HTTP routes are served by the main backend app (port 30001) under
      // /plugin-api/<id>; the plugin host enforces auth globally for them.
      const info: ServiceInfo = {
        key: `plugin-${pluginId}`,
        file: appOrigin.file,
        port: 30001,
        globalAuth: true,
        globalAuthLine: null,
        bodyLimits: {},
      };
      serviceInfoByFile.set(appOrigin.file, info);
      return info;
    }
    const sf = project.getSourceFiles().find((f) => toRel(f.getFilePath()) === appOrigin.file);
    const scanned = findPortInFile(sf);
    const configEntry = servicesConfig[appOrigin.file];
    const port = scanned ?? configEntry?.port ?? null;
    const service =
      configEntry?.service ??
      appOrigin.file
        .replace(/^.*\/(hosts|services|database)\//, "")
        .replace(/\/index\.ts$|\.ts$/, "")
        .replace(/\//g, "-") ??
      "unknown";

    let globalAuth = false;
    let globalAuthLine: number | null = null;
    let authUseLine: number | null = null;
    if (sf) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (
          Node.isPropertyAccessExpression(callee) &&
          callee.getName() === "use" &&
          call.getArguments().length === 1
        ) {
          const arg = call.getArguments()[0];
          if (Node.isCallExpression(arg)) {
            const argCallee = arg.getExpression();
            if (Node.isPropertyAccessExpression(argCallee) && argCallee.getName() === "createAuthMiddleware") {
              authUseLine = call.getStartLineNumber();
              break;
            }
          }
        }
      }
      globalAuth = authUseLine !== null;
      globalAuthLine = authUseLine;
    }

    const info: ServiceInfo = {
      key: service,
      file: appOrigin.file,
      port,
      globalAuth,
      globalAuthLine,
      bodyLimits: {},
    };
    serviceInfoByFile.set(appOrigin.file, info);
    return info;
  }

  interface Reached {
    appOrigin: OriginNode;
    prefix: string;
  }

  const prefixMemo = new Map<string, Reached[]>();
  function prefixTo(node: OriginNode, stack: Set<string> = new Set()): Reached[] {
    const cached = prefixMemo.get(node.key);
    if (cached) return cached;
    if (stack.has(node.key)) return [];
    stack.add(node.key);

    const edges = mountEdgesByTarget.get(node.key) ?? [];
    const out: Reached[] = [];
    for (const edge of edges) {
      for (const parent of prefixTo(edge.from, stack)) {
        out.push({ appOrigin: parent.appOrigin, prefix: joinPaths(parent.prefix, edge.prefix) });
      }
    }
    // A top-level express() app is a root only when nothing mounts it and it is
    // not inside a plugin. Plugins may create their own express() app and mount
    // it from the plugin router, so those must keep traversing their mount edges.
    if (out.length === 0 && node.kind === "app" && !pluginIdForFile(node.file)) {
      out.push({ appOrigin: node, prefix: "" });
    }
    // A plugin's root router (or its own unmounted express() app) has no in-source
    // mount edge — the host mounts it at /plugin-api/<id>. Synthesize that prefix.
    if (out.length === 0) {
      const pluginId = pluginIdForFile(node.file);
      if (pluginId) {
        out.push({ appOrigin: pluginAppOrigin(pluginId), prefix: `/plugin-api/${pluginId}` });
      }
    }
    stack.delete(node.key);
    const deduped = dedupeReached(out);
    prefixMemo.set(node.key, deduped);
    return deduped;
  }

  function dedupeReached(list: Reached[]): Reached[] {
    const seen = new Map<string, Reached>();
    for (const r of list) seen.set(`${r.appOrigin.key}:${r.prefix}`, r);
    return [...seen.values()];
  }

  function joinPaths(...parts: string[]): string {
    let out = "";
    for (const part of parts) {
      if (!part) continue;
      out += part.startsWith("/") ? part : `/${part}`;
    }
    out = out.replace(/\/{2,}/g, "/");
    if (out === "") out = "/";
    if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  }

  // ---- finalize ----

  const routes: RouteRecord[] = [];
  const routesByCallSite = new Map<string, RouteRecord[]>();
  const handlerIndex = new Map<string, { handler: Node; call: Node }>();

  for (const raw of rawRoutes) {
    if (raw.pathSegment === null) continue; // already reported to unresolved
    const reached = prefixTo(raw.origin);
    if (reached.length === 0) {
      unresolved.push({
        file: raw.file,
        line: raw.line,
        reason: `origin (${raw.origin.kind} declared at ${raw.origin.file}:${raw.origin.line}) never reaches an express() app via a resolvable mount chain`,
        snippet: `${raw.method} ${raw.pathText}`,
      });
      continue;
    }
    for (const r of reached) {
      const finalPath = joinPaths(r.prefix, raw.pathSegment);
      const svc = serviceInfoFor(r.appOrigin);
      const id = `${raw.file}#L${raw.line}:${raw.method}:${finalPath}`;
      const record: RouteRecord = {
        id,
        method: raw.method,
        path: finalPath,
        expressPath: raw.pathSegment,
        service: svc.key,
        port: svc.port,
        file: raw.file,
        line: raw.line,
        handlerKind: raw.handlerKind,
        middlewares: raw.middlewares,
        sharedHandlerWith: [],
        anyMethod: raw.anyMethod,
      };
      routes.push(record);
      handlerIndex.set(id, { handler: raw.handlerNode, call: raw.callNode });
      const group = routesByCallSite.get(raw.callSiteId) ?? [];
      group.push(record);
      routesByCallSite.set(raw.callSiteId, group);
    }
  }

  for (const group of routesByCallSite.values()) {
    if (group.length < 2) continue;
    for (const r of group) r.sharedHandlerWith = group.filter((o) => o !== r).map((o) => o.id);
  }

  const services = [...serviceInfoByFile.values()].sort((a, b) => (a.port ?? 0) - (b.port ?? 0));

  let expressVersion: string | null = null;
  try {
    const pkgFile = project
      .getSourceFiles()
      .find((f) => f.getFilePath().endsWith("node_modules/express/package.json"));
    void pkgFile; // ts-morph doesn't add package.json as a source file; left for clarity
  } catch {
    /* best-effort only */
  }

  const sortedRoutes = routes.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ir: {
      meta: {
        tag: "",
        commit: "",
        generatedAt: new Date().toISOString(),
        sourceRepo: repoPath,
        expressVersion,
      },
      services,
      routes: sortedRoutes,
      unresolved,
    },
    handlerIndex,
  };
}
