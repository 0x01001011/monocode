import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Installs the host built from this checkout on an SSH machine. "Update Host"
// in the desktop app downloads the published release for the same version, so
// a development build's host changes never reach a machine that way.
//
//   npm run host:deploy -- user@machine [--port 3774] [--dry-run] [--no-build]
//
// The previous runtime stays on the machine, and its path is saved in
// ~/.monocode-host/previous-runtime so the change can be rolled back.

const SYSTEMS = { Linux: "linux", Darwin: "darwin" };
const ARCHES = { x86_64: "x64", amd64: "x64", arm64: "arm64", aarch64: "arm64" };

/** The package target for the last two lines of `uname -s; uname -m`. Login
 * banners can print before them, so only the tail is read. */
export function parseTarget(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const [system, machine] = lines.slice(-2);
  const os = SYSTEMS[system];
  const arch = ARCHES[machine];
  if (!os || !arch)
    throw new Error(
      `Unsupported machine: ${system ?? "unknown"} ${machine ?? "unknown"}. Hosts run on Linux or macOS.`,
    );
  return `${os}-${arch}`;
}

/** Rejects anything ssh could read as an option or a second command. */
export function validateTarget(target) {
  if (!/^[A-Za-z0-9._@:[\]-]{1,255}$/.test(target) || target.startsWith("-"))
    throw new Error(`Not an SSH target: ${target}`);
  return target;
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Not a port: ${value}`);
  return port;
}

/** The remote install: verifies the uploaded archive, unpacks it beside the
 * existing runtimes, then points the launcher and the service at it. */
export function installScript({ sha256, version, port, upload }) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid checksum");
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid version");
  validatePort(port);
  return `set -eu
umask 077
BASE="$HOME/.monocode-host"
ARCHIVE=${upload}
trap 'rm -f "$ARCHIVE"' EXIT
mkdir -p "$BASE/runtime" "$BASE/bin"
cat > "$ARCHIVE"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$ARCHIVE" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}'); fi
[ "$ACTUAL" = '${sha256}' ] || { echo 'Host archive checksum mismatch.' >&2; exit 1; }
DEST="$BASE/runtime/${version}-local-$(date +%s)"
mkdir "$DEST"
tar -xzf "$ARCHIVE" -C "$DEST" 2>/dev/null
[ "$("$DEST/monocode-host" --version)" = '${version}' ] || { rm -rf "$DEST"; echo 'Host version mismatch.' >&2; exit 1; }
[ -f "$BASE/runtime-path" ] && cp "$BASE/runtime-path" "$BASE/previous-runtime"
printf '%s\\n' "$DEST" > "$BASE/runtime-path.new"
mv "$BASE/runtime-path.new" "$BASE/runtime-path"
if [ ! -x "$BASE/bin/monocode-host" ]; then
  printf '#!/bin/sh\\nset -eu\\nBASE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\\nRUNTIME=$(cat "$BASE/runtime-path")\\nexec "$RUNTIME/monocode-host" "$@"\\n' > "$BASE/bin/monocode-host"
  chmod 700 "$BASE/bin/monocode-host"
fi
"$BASE/bin/monocode-host" service uninstall >/dev/null 2>&1 || true
"$BASE/bin/monocode-host" service install --port ${port} >/dev/null
echo "Installed $DEST"
`;
}

function parseArgs(argv) {
  const options = { port: 3774, dryRun: false, build: true, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--port") options.port = validatePort(argv[++i]);
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.target) throw new Error("Give one SSH target");
    else options.target = validateTarget(arg);
  }
  if (!options.target)
    throw new Error(
      "Usage: npm run host:deploy -- user@machine [--port 3774] [--dry-run] [--no-build]",
    );
  return options;
}

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const probe = execFileSync(
    "ssh",
    [...SSH, "--", options.target, "uname -s; uname -m"],
    { encoding: "utf8" },
  );
  const target = parseTarget(probe);
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  console.log(`${options.target}: ${target}, host ${version}`);
  if (options.build) {
    execFileSync("npm", ["run", "host:build"], { stdio: "inherit" });
    execFileSync(process.execPath, ["host/package.mjs", "--target", target], {
      stdio: "inherit",
    });
  }
  const archive = resolve(`build/host-packages/monocode-host-${target}.tar.gz`);
  const sha256 = (await readFile(`${archive}.sha256`, "utf8")).split(/\s+/)[0];
  const script = installScript({
    sha256,
    version,
    port: options.port,
    upload: `"$HOME/.monocode-host/runtime/.upload-$$"`,
  });
  if (options.dryRun) {
    console.log(`Would upload ${archive} and run:\n${script}`);
    return;
  }
  // The script travels base64-encoded in the command, so no login shell sees
  // a quote or other special character, and stdin carries only the archive.
  const encoded = Buffer.from(script).toString("base64");
  const remote = spawn(
    "ssh",
    [...SSH, "--", options.target, remoteCommand(encoded)],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  await new Promise((done, fail) => {
    createReadStream(archive).on("error", fail).pipe(remote.stdin);
    remote.on("error", fail);
    remote.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`Install failed (exit ${code})`)),
    );
  });
  console.log(
    "Done. Reconnect the machine in MonoCode (Settings → Connections). Do not use Update Host: it reinstalls the published release.",
  );
}

/** The ssh command that runs a base64-encoded script with `sh`. */
export function remoteCommand(encoded) {
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error("Invalid script");
  return `sh -c 'eval "$(echo ${encoded} | base64 -d)"'`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
