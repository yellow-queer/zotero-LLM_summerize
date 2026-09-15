/**
 * Build pipeline: bundle TypeScript with esbuild and package a `.xpi`.
 *
 * Why not a full plugin-scaffold dependency? The whole point of this plugin is
 * to stay lightweight, and the template's scaffold pulls in a large dependency
 * tree for what amounts to two steps:
 *
 *   1. esbuild `src/index.ts` → one IIFE that `bootstrap.js` can load with
 *      `Services.scriptloader.loadSubScript`.
 *   2. Zip `addon/**` plus that bundle into an `.xpi`, replacing the
 *      `__placeholder__` tokens in `manifest.json` / `bootstrap.js` / `prefs.js`
 *      and prefixing prefs with `extensions.zotero.<addonRef>.`.
 *
 * The ZIP writer below is intentionally hand-rolled so the build has exactly one
 * dependency (esbuild) and no native modules.
 *
 * Usage:
 *   npm run build             # production bundle → build/zotero-llm-summarizer.xpi
 *   npm run build -- --dev    # development bundle (verbose logging, sourcemaps)
 */
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const config = pkg.config;

const isDev = process.argv.includes("--dev");
const env = isDev ? "development" : "production";

const buildDir = join(root, "build");
const stageDir = join(buildDir, "addon");
const bundleName = `${config.addonRef}.js`;
const xpiName = "zotero-llm-summarizer.xpi";

/**
 * Local-time stamp with an explicit UTC offset, e.g. `2026-09-15 01:27:33 +08:00`.
 *
 * Deliberately not `toISOString()`: that returns UTC, so the stamp shown in
 * Zotero's debug log would sit hours away from the clock of whoever ran the
 * build — and correlating the two is the entire point of the stamp.
 */
function buildTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Tokens substituted across the staged addon files. */
function defineMap() {
  return {
    __addonName__: config.addonName,
    __addonID__: config.addonID,
    __addonRef__: config.addonRef,
    __addonInstance__: config.addonInstance,
    __buildVersion__: pkg.version,
    __buildTime__: buildTimestamp(new Date()),
    __description__: pkg.description,
    __author__: pkg.author ?? "unknown",
    __updateURL__: config.updateURL,
    __strictMaxVersion__: config.strictMaxVersion,
  };
}

// --------------------------------------------------------------------- bundle

async function bundle() {
  const define = {};
  for (const [key, value] of Object.entries(defineMap())) {
    define[key] = JSON.stringify(value);
  }
  define.__env__ = JSON.stringify(env);
  // `src/utils/prefs.ts` builds every pref name from this, so the bundle and the
  // staged `prefs.js` below cannot disagree about where prefs live.
  define.__prefsPrefix__ = JSON.stringify(config.prefsPrefix);

  await build({
    entryPoints: [join(root, "src", "index.ts")],
    outfile: join(stageDir, "content", "scripts", bundleName),
    bundle: true,
    format: "iife",
    // Zotero 7 runs Firefox 102+ ESR; 115 is the current baseline for the
    // plugin sandbox and keeps optional chaining / class fields untranspiled.
    target: "firefox115",
    platform: "browser",
    charset: "utf8",
    minify: !isDev,
    sourcemap: isDev ? "inline" : false,
    legalComments: "none",
    define,
    logLevel: "info",
  });
}

// ---------------------------------------------------------------------- stage

/** Recursively lists files under `dir`, returning paths relative to `root`. */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function stage() {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  const define = defineMap();
  const addonDir = join(root, "addon");

  for (const file of await walk(addonDir)) {
    const rel = relative(addonDir, file);
    const target = join(stageDir, rel);
    await mkdir(dirname(target), { recursive: true });

    const isText = /\.(json|js|xhtml|css|ftl|txt)$/i.test(file);
    if (!isText) {
      await writeFile(target, await readFile(file));
      continue;
    }

    let content = await readFile(file, "utf8");
    for (const [token, value] of Object.entries(define)) {
      content = content.split(token).join(value);
    }

    // `prefs.js` declares short names; Zotero requires fully-qualified keys.
    if (rel === "prefs.js") {
      content = content.replace(
        /^pref\(\s*"([^"]+)"/gm,
        (_match, name) => `pref("${config.prefsPrefix}.${name}"`,
      );
    }

    await writeFile(target, content);
  }

  await bundle();
  await verifyManifest();
}

/**
 * Fails the build if the staged manifest is missing what Zotero requires.
 *
 * Zotero patches the toolkit's `Extension.sys.mjs` to demand three keys under
 * `applications.zotero`, and reports a missing one through `manifestError()` →
 * `packagingError()`, which only appends to the extension's `errors` array.
 * The failure surfaces later, in `loadManifest()` → `ensureNoErrors()`, which
 * *throws* — so the plugin simply never loads, with nothing in the Add-ons
 * window explaining why. `update_url` in particular is easy to mistake for an
 * optional nicety; without it the plugin is dead on arrival, so it is checked
 * here rather than discovered after publishing.
 */
async function verifyManifest() {
  const file = join(stageDir, "manifest.json");
  const raw = await readFile(file, "utf8");

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Staged manifest.json is not valid JSON: ${e.message}`);
  }

  const missing = [];
  for (const key of ["id", "update_url", "strict_max_version"]) {
    if (!manifest.applications?.zotero?.[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(
      `Staged manifest.json is missing applications.zotero.${missing.join(", ")} — ` +
        "Zotero refuses to load an extension without these. See the comment on verifyManifest().",
    );
  }

  // A leftover `__token__` means a placeholder has no entry in defineMap().
  const unresolved = raw.match(/__[a-zA-Z][a-zA-Z0-9]*__/g);
  if (unresolved) {
    throw new Error(
      `Staged manifest.json still contains unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`,
    );
  }
}

// ------------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, as required by the ZIP local file header. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Builds a ZIP archive containing every file under `stageDir`.
 *
 * Entries use method 8 (deflate), which requires a *raw* deflate stream —
 * `deflateRawSync`, not `deflateSync`. The latter adds a zlib (RFC 1950) header
 * and Adler-32 trailer that no ZIP reader expects, and archives built with it
 * unpack as "invalid compressed data to inflate".
 */
async function zipDirectory(dir) {
  const files = (await walk(dir)).sort();
  const now = new Date();
  const { time, day } = dosDateTime(now);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    // ZIP requires forward slashes regardless of platform.
    const name = relative(dir, file).split(sep).join("/");
    const data = await readFile(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(0x031e, 4); // version made by (UNIX, 3.0)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    // External attributes: unix mode 0o100644 (regular file) in the high 16
    // bits. `>>> 0` is required because `<<` produces a signed 32-bit value,
    // and 0o100644 << 16 exceeds 2^31.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return { buffer: Buffer.concat([...localParts, centralDirectory, end]), files };
}

// --------------------------------------------------------------- update manifest

/**
 * Writes the Mozilla-format update manifest that `applications.zotero.update_url`
 * must point at.
 *
 * Zotero fetches this URL to discover new versions; `update_hash` is verified
 * against the downloaded XPI, so it has to be regenerated on every build — hence
 * generating it here instead of hand-maintaining a file that silently goes stale.
 *
 * The `update_link` is derived from `config.updateURL` by swapping the filename,
 * which assumes both are published side by side (the usual GitHub-release layout).
 * If they live elsewhere, set the two paths independently before publishing.
 */
async function writeUpdateManifest(buffer) {
  const hash = createHash("sha256").update(buffer).digest("hex");

  const target = new URL(config.updateURL);
  target.pathname = target.pathname.replace(/[^/]*$/, xpiName);

  const manifest = {
    addons: {
      [config.addonID]: {
        updates: [
          {
            version: pkg.version,
            update_link: target.toString(),
            update_hash: `sha256:${hash}`,
            applications: {
              zotero: { strict_min_version: "7.0" },
            },
          },
        ],
      },
    },
  };

  await writeFile(join(buildDir, "updates.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { hash, updateLink: target.toString() };
}

// ----------------------------------------------------------------------- main

async function main() {
  await mkdir(buildDir, { recursive: true });
  await stage();

  const { buffer, files } = await zipDirectory(stageDir);
  const outFile = join(buildDir, xpiName);
  await writeFile(outFile, buffer);
  await writeUpdateManifest(buffer);

  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`\n✔ ${relative(root, outFile).split(sep).join("/")}  (${files.length} files, ${kb} KB)`);
  console.log(`  env=${env}  version=${pkg.version}`);
  for (const file of files.map((f) => relative(stageDir, f).split(sep).join("/"))) {
    console.log(`   · ${file}`);
  }
  console.log("  · updates.json  (auto-update manifest — host next to the .xpi)");
  console.log("\nInstall: Zotero → Tools → Add-ons → ⚙ → Install Add-on From File…");
}

await main();
