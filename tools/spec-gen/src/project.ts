/** Loads the ts-morph Projects used by every extraction phase. */

import { Project } from "ts-morph";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * The backend Project, loaded from Termix's own tsconfig.node.json. This is
 * the project used by Phases 1-6 and 8: route discovery, auth/params, request
 * bodies, responses, Drizzle schema, test-example cross-checking, and JSDoc text.
 */
export function loadBackendProject(repoPath: string): Project {
  const tsConfigFilePath = join(repoPath, "tsconfig.node.json");
  if (!existsSync(tsConfigFilePath)) {
    throw new Error(`tsconfig.node.json not found at ${tsConfigFilePath}`);
  }
  const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
  // Termix 2.9 moved host features (docker, file-manager, snippets, tunnels, ...) into
  // plugins served from `plugins/<id>/src/backend`. Those files are outside
  // tsconfig.node.json's include, so add them explicitly or Phase 1 never sees them.
  project.addSourceFilesAtPaths([
    join(repoPath, "plugins/*/src/backend/**/*.ts"),
    join(repoPath, "packages/plugin-sdk/src/**/*.ts"),
  ]);
  return project;
}

/**
 * A second, more lenient Project covering the frontend HTTP client
 * (src/ui/main-axios.ts, src/ui/api/*.ts) plus the shared src/types tree it
 * depends on. Used by Phase 7. Built manually (not from tsconfig.app.json)
 * because the app tsconfig pulls in Vite/React types we don't need and would
 * rather not have to resolve just to read exported function signatures.
 */
export function loadFrontendProject(repoPath: string): Project {
  const project = new Project({
    compilerOptions: {
      target: 99 /* ESNext */,
      module: 199 /* ESNext */,
      moduleResolution: 100 /* Bundler */,
      esModuleInterop: true,
      skipLibCheck: true,
      allowJs: false,
      strict: false,
      noImplicitAny: false,
      // Mirrors tsconfig.app.json's alias for "@/..." imports (vite.config.ts resolve.alias
      // agrees: "@/types" -> src/types, "@" -> src/ui). Without this, every cross-file
      // `import { hostApi } from "@/main-axios"` in src/ui/api/*.ts fails to resolve, and
      // symbol resolution back to main-axios.ts's instance declarations silently breaks.
      baseUrl: repoPath.replace(/\\/g, "/"),
      paths: {
        "@/types": ["src/types/index.ts"],
        "@/types/*": ["src/types/*"],
        "@/*": ["src/ui/*"],
      },
    },
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([
    join(repoPath, "src/ui/main-axios.ts"),
    join(repoPath, "src/ui/api/**/*.ts"),
    join(repoPath, "src/types/**/*.ts"),
    join(repoPath, "src/ui/types/**/*.ts"),
  ]);
  return project;
}

export function relFile(repoPath: string, absPath: string): string {
  // ts-morph always reports getFilePath() with forward slashes, but repoPath comes from
  // node:path (join()), which is backslash-separated on Windows — normalize both sides
  // before the prefix check, or a real (non-"--repo") run silently matches zero files.
  const normRepo = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normAbs = absPath.replace(/\\/g, "/");
  const rel = normAbs.startsWith(normRepo) ? normAbs.slice(normRepo.length) : normAbs;
  return rel.replace(/^\/+/, "");
}
