/**
 * verify-release.mjs — every RELATIVE import inside a release tarball must
 * resolve inside that same tarball.
 *
 * The failure this guards (2026-09-11): the umbrella `dsh-runtime` copied a
 * fixed list of seam files into lib/seam/, so when the seam gained a sibling
 * (lib/pre-continuation.mjs) the published tarball shipped an index.js that
 * imports a file the tarball does not contain. Nothing fails at pack time --
 * the install throws ERR_MODULE_NOT_FOUND, and only for whoever installs it.
 *
 *   node scripts/verify-release.mjs          (exit 1 on any unresolved import)
 *
 * Bare specifiers (react, @deepseek-ai/schemastery, node:*) are the host's
 * business and are not checked; only paths that must travel with the package.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_OUT = join(REPO, "release");

const SPECIFIER_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Candidate files a relative specifier may resolve to, in Node's order. */
function candidates(fromEntry, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(fromEntry), specifier));
  return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.mjs`];
}

/**
 * @param out - directory holding the packed tarballs.
 * @returns an array of human-readable problems; empty means every tarball is
 *          self-contained.
 */
export function verifyRelease(out = DEFAULT_OUT) {
  const problems = [];
  let tarballs = 0;
  let checked = 0;
  // Run tar with `cwd: out` and a BARE filename. Handing tar an absolute
  // Windows path makes this PATH-dependent: bsdtar reads "D:\..." as local,
  // while GNU tar (the one MSYS ships) reads the drive letter as a remote host
  // and dies with "Cannot connect to D: resolve failed" -- which is exactly how
  // this broke pack-release on 2026-09-13.
  const tar = (args) => execFileSync("tar", args, { cwd: out, encoding: "utf8", maxBuffer: 1 << 28 });
  for (const name of readdirSync(out)) {
    if (!name.endsWith(".tgz")) continue;
    tarballs += 1;
    const entries = tar(["-tzf", name])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const present = new Set(entries);
    for (const entry of entries) {
      if (!/\.(?:js|mjs|cjs)$/.test(entry)) continue;
      checked += 1;
      const source = tar(["-xzOf", name, entry]);
      for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match = pattern.exec(source);
        while (match !== null) {
          const specifier = match[1];
          if (specifier.startsWith(".") && !candidates(entry, specifier).some((c) => present.has(c))) {
            problems.push(`${name}: ${entry} imports "${specifier}" which the tarball does not contain`);
          }
          match = pattern.exec(source);
        }
      }
    }
  }
  return { problems, tarballs, files: checked };
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const out = process.argv[2] ?? DEFAULT_OUT;
  const { problems, tarballs, files } = verifyRelease(out);
  for (const problem of problems) console.log(`FAIL ${problem}`);
  console.log(
    `${problems.length === 0 ? "PASS" : "FAILED"} ${tarballs} tarball(s), ${files} module(s): ` +
      `${problems.length} unresolved relative import(s)`,
  );
  process.exit(problems.length === 0 ? 0 : 1);
}
