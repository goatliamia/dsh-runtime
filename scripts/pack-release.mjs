/**
 * pack-release.mjs — build self-contained, standalone-installable tgzs.
 *
 * The monorepo's file:../runtime-progress workspace dep only resolves inside a
 * full checkout. For anyone who just wants to install, this script produces
 * release/ tgzs with ZERO cross-package file: deps:
 *   - dsh-runtime-progress: packed as-is (no dependencies);
 *   - dsh-runtime-circuit|reconcile|investigate: the progress lib is bundled
 *     inside (import rewritten to the bundled copy) — one tgz, installable
 *     anywhere with `dsh plugin add <tgz>`.
 *
 * Usage: node scripts/pack-release.mjs  (output: release/)
 */
import { mkdirSync, rmSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { verifyRelease } from "./verify-release.mjs";

const REPO = join(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(REPO, "release");
const PROGRESS_LIB = join(REPO, "core", "runtime-progress", "lib", "index.js");

// Remove only what this script owns. A bare rmSync(OUT) also deleted artifacts
// packed elsewhere -- it removed release/dsh-notify-0.1.0.tgz on 2026-09-11.
mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) {
  if (name.startsWith("dsh-runtime") && name.endsWith(".tgz")) rmSync(join(OUT, name), { force: true });
  else if (name.startsWith(".tmp-")) rmSync(join(OUT, name), { recursive: true, force: true });
}

function pack(cwd) {
  execSync("pnpm pack --pack-destination " + JSON.stringify(OUT), { cwd, stdio: "inherit" });
}

// 1) fact layer: pack as-is (zero dependencies).
pack(join(REPO, "core", "runtime-progress"));

// 1b) seam: pack as-is (registry dep @deepseek-ai/schemastery resolves from npm).
pack(join(REPO, "core", "runtime-seam"));

// 1c) child orchestration layer: pack as-is (zero dependencies). Deliberately
//     NOT part of the umbrella bundle: only an orchestration layer consumes it.
pack(join(REPO, "core", "runtime-orchestration"));

// 2) policies: bundle the progress lib, drop the file: dep.
for (const pkg of ["runtime-circuit", "runtime-reconcile", "runtime-investigate"]) {
  const src = join(REPO, "core", pkg);
  const tmp = join(OUT, `.tmp-${pkg}`);
  mkdirSync(join(tmp, "lib", "runtime-progress"), { recursive: true });

  const pkgJson = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  delete pkgJson.dependencies;
  pkgJson.description = `${pkgJson.description} (self-contained release bundle: dsh-runtime-progress included)`;
  writeFileSync(join(tmp, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`);

  const lib = readFileSync(join(src, "lib", "index.js"), "utf8");
  const bundled = lib.replaceAll('from "dsh-runtime-progress"', 'from "./runtime-progress/index.js"');
  writeFileSync(join(tmp, "lib", "index.js"), bundled);
  copyFileSync(PROGRESS_LIB, join(tmp, "lib", "runtime-progress", "index.js"));
  copyFileSync(join(src, "cordis.patch.yml"), join(tmp, "cordis.patch.yml"));

  pack(tmp);
  rmSync(tmp, { recursive: true, force: true });
}

// 3) umbrella bundle dsh-runtime: ONE install for users. Bundles all five
//    modules under one package; each module keeps its original plugin id.
//    Users then pick the mode / scene / custom toggles in the settings UI —
//    they never choose packages.
{
  const tmp = join(OUT, ".tmp-dsh-runtime");
  mkdirSync(join(tmp, "lib", "progress"), { recursive: true });
  mkdirSync(join(tmp, "lib", "circuit"), { recursive: true });
  mkdirSync(join(tmp, "lib", "reconcile"), { recursive: true });
  mkdirSync(join(tmp, "lib", "investigate"), { recursive: true });
  mkdirSync(join(tmp, "lib", "seam"), { recursive: true });

  writeFileSync(
    join(tmp, "package.json"),
    `${JSON.stringify({
      name: "dsh-runtime",
      version: "0.1.0",
      description: "DSH Runtime: progress fact layer + circuit/reconcile/investigate policies + runtime seam. One install; choose the mode, scene preset, or custom capability toggles in the settings UI.",
      type: "module",
      main: "./lib/progress/index.js",
      exports: {
        ".": "./lib/progress/index.js",
        "./lib/progress": "./lib/progress/index.js",
        "./lib/circuit": "./lib/circuit/index.js",
        "./lib/reconcile": "./lib/reconcile/index.js",
        "./lib/investigate": "./lib/investigate/index.js",
        "./lib/seam": "./lib/seam/index.js",
        "./client": "./lib/client.js",
        "./package.json": "./package.json",
      },
      dependencies: {
        "@deepseek-ai/schemastery": "^3.18.1",
      },
      dsh: {
        bundle: { patch: "./cordis.patch.yml" },
        client: { platform: "web", inject: [] },
      },
    }, null, 2)}\n`,
  );

  writeFileSync(
    join(tmp, "cordis.patch.yml"),
    [
      "# dsh-runtime umbrella: mount all five modules (one install, choose mode in settings).",
      "- insert:",
      "    - id: runtime-progress",
      "      name: 'dsh-runtime/lib/progress'",
      "    - id: runtime-circuit",
      "      name: 'dsh-runtime/lib/circuit'",
      "    - id: runtime-reconcile",
      "      name: 'dsh-runtime/lib/reconcile'",
      "    - id: runtime-investigate",
      "      name: 'dsh-runtime/lib/investigate'",
      "    - id: dsh-runtime-seam",
      "      name: 'dsh-runtime/lib/seam'",
      "",
    ].join("\n"),
  );

  copyFileSync(PROGRESS_LIB, join(tmp, "lib", "progress", "index.js"));
  for (const pkg of ["runtime-circuit", "runtime-reconcile", "runtime-investigate"]) {
    const lib = readFileSync(join(REPO, "core", pkg, "lib", "index.js"), "utf8");
    writeFileSync(join(tmp, "lib", pkg.replace("runtime-", ""), "index.js"), lib.replaceAll('from "dsh-runtime-progress"', 'from "../progress/index.js"'));
  }
  // The seam is the ONE module with sibling runtime files: index.js imports
  // ./core.mjs and ./pre-continuation.mjs next to itself. Copying a fixed list
  // shipped an umbrella whose seam threw ERR_MODULE_NOT_FOUND on load as soon
  // as a sibling was added (pre-continuation.mjs, 2026-09-03). Copy the whole
  // lib/ instead, and route client.js to the path package.json declares.
  const seamLib = join(REPO, "core", "runtime-seam", "lib");
  for (const entry of readdirSync(seamLib, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "client.js") continue;
    copyFileSync(join(seamLib, entry.name), join(tmp, "lib", "seam", entry.name));
  }
  copyFileSync(join(seamLib, "client.js"), join(tmp, "lib", "client.js"));;

  pack(tmp);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`release tarballs written to ${OUT}`);

// A tarball that imports a file it does not contain fails only at install time,
// for whoever installs it. Check every packed tarball before declaring success.
const { problems, tarballs, files } = verifyRelease(OUT);
for (const problem of problems) console.error(`FAIL ${problem}`);
if (problems.length > 0) {
  console.error(`release pack FAILED: ${problems.length} unresolved relative import(s)`);
  process.exit(1);
}
console.log(`verified ${tarballs} tarball(s), ${files} module(s): self-contained`);
