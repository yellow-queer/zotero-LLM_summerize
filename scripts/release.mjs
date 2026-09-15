/**
 * Release helper: bump the version, rebuild, and print exactly what to publish.
 *
 * This exists because of one specific failure mode. Zotero decides whether an
 * update exists with `Services.vc.compare(remoteVersion, installedVersion)` — so
 * if the version is not raised, publishing a new `.xpi` is invisible to everyone
 * who already has the plugin, no matter how much the code changed. Forgetting
 * the bump is silent: the build succeeds, the upload succeeds, and nothing
 * happens on any user's machine.
 *
 * So the bump is a build step rather than a thing to remember, and the last
 * assertion below re-reads `build/updates.json` to prove the version Zotero will
 * actually see is the new one.
 *
 * Usage:
 *   npm run release patch       # 0.1.0 → 0.1.1
 *   npm run release minor       # 0.1.0 → 0.2.0
 *   npm run release major       # 0.1.0 → 1.0.0
 *   npm run release 1.2.3       # explicit version
 */
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");

const BUMPABLE = ["major", "minor", "patch"];

/**
 * Applies a semver bump. Purely numeric and prerelease-free on purpose: Zotero
 * compares versions the way Mozilla does, where a suffix like `-beta.1` sorts
 * *below* the release it precedes — an easy way to publish something that looks
 * newer to a human and older to the updater.
 */
function bumpVersion(current, spec) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    throw new Error(`package.json 里的版本号 "${current}" 不是 x.y.z 形式，无法自动递增。`);
  }
  if (spec === undefined) {
    throw new Error("请指定版本：npm run release patch|minor|major|<x.y.z>");
  }

  if (!BUMPABLE.includes(spec)) {
    if (!/^\d+\.\d+\.\d+$/.test(spec)) {
      throw new Error(`无法识别的版本参数 "${spec}"：应为 patch / minor / major 或 x.y.z。`);
    }
    return spec;
  }

  const [major, minor, patch] = match.slice(1).map(Number);
  if (spec === "major") {
    return `${major + 1}.0.0`;
  }
  if (spec === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

async function main() {
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  const next = bumpVersion(pkg.version, process.argv[2]);
  if (next === pkg.version) {
    // Possible when the version is passed explicitly. Letting it through would
    // rebuild and republish something no installed copy will ever pick up.
    throw new Error(`版本号仍是 ${next}，没有变化 —— 请提高版本。`);
  }

  // Rewrite only the version line so comments and key order elsewhere — if this
  // file ever gains them — survive a release.
  await writeFile(pkgPath, raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${next}"`), "utf8");
  console.log(`\n版本：${pkg.version} → ${next}\n`);

  // One command string rather than `npm` + args: with `shell: true` Node warns
  // about unescaped args (DEP0190), and there are no args to escape here.
  const build = spawnSync("npm run build", { cwd: root, stdio: "inherit", shell: true });
  if (build.status !== 0) {
    // The bump has to come first — the version is baked into the bundle and the
    // manifest — so a failed build leaves package.json already raised.
    console.error(`\n构建失败。package.json 的版本已改为 ${next}，如需撤销：`);
    console.error(`  把 "version" 改回 "${pkg.version}"\n`);
    process.exit(build.status ?? 1);
  }

  const updates = JSON.parse(await readFile(join(root, "build", "updates.json"), "utf8"));
  const entry = updates.addons[pkg.config.addonID]?.updates?.[0];
  if (entry?.version !== next) {
    console.error(`\n构建产物里的版本是 "${entry?.version}"，不是 "${next}" —— 更新会被 Zotero 忽略。`);
    process.exit(1);
  }

  console.log(`
已构建 ${next}，待发布的两个文件（必须同一次发布、同一目录）：

  build/zotero-llm-summarizer.xpi
  build/updates.json

上线后逐个核对：
  1. updates.json 已可公开访问，且其中 update_link 指向的正是刚上传的 .xpi；
  2. 不要改动 .xpi —— 它的 sha256 已写进 update_hash（${entry.update_hash.slice(0, 23)}…），改动一个字节即校验失败；
  3. 打开 about:config 看 extensions.update.interval（默认 86400 秒）决定用户多久检查一次；
     想立刻验证就手动触发一次检查，或在调试日志里搜 ${pkg.config.addonRef}。
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
