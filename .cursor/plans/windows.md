### 🚧 Multi-platform sanity-check (focus = Windows)  
The Linux/macOS path is already solid. Below are the **four Windows trip-wires** I found, followed by the **exact fixes / snippets / steps**—all accomplished with small, battle-tested NPM packages (no bespoke “clever hacks”).

| Area | Why it breaks on Win | Drop-in cure |
|------|---------------------|--------------|
| **Shell discovery** | `process.env.SHELL` is undefined; hard-fallback to `bash` explodes. | [`default-shell`](https://www.npmjs.com/package/default-shell) gives you the user’s actual default shell (`cmd.exe`, PowerShell, Git Bash, etc.). |
| **Killing the PTY** | `node-pty.kill("SIGTERM")` ignores the signal on Windows (docs literally say “signal not supported”). | [`fkill`](https://www.npmjs.com/package/fkill) (already uses `taskkill /T /F` under the hood). |
| **Tail hint in logs** | The Unix hint you emit: `tail -f /path/to/log` → 🐛 `tail` isn’t a thing on stock Windows. | [`powershell-tail`](https://www.npmjs.com/package/powershell-tail) (tiny wrapper that shells out to `Get-Content -Wait -Tail …`). |
| **CI coverage** | No Windows job, so breakage sneaks in. | Add a simple `windows-latest` matrix leg; everything else stays identical. |

---

## 1 ️⃣ Install the helpers

```bash
pnpm add default-shell fkill powershell-tail
```

*(They’re tiny, no native bindings, so they install instantly on all OSes.)*

---

## 2 ️⃣ Shell detection – `src/ptyManager.ts`

```ts
import defaultShell from "default-shell";   // ⬅ new

export function spawnPtyProcess(
  _shell: string, // param ignored below
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
  cols = 80,
  rows = 30,
) {
  const shell = defaultShell || process.env.ComSpec || "cmd.exe";  // win-safe
  …
}
```

*Why:* `default-shell` resolves to *“whatever the user normally types commands in”* and supports WSL out-of-box.

---

## 3 ️⃣ Cross-platform kill – replace `killPtyProcess` entirely

```ts
import fkill from "fkill";  // ⬅ new

export async function killPtyProcess(
  ptyProcess: pty.IPty,
  label: string,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<boolean> {
  try {
    await fkill(ptyProcess.pid!, {tree: true, force: signal === "SIGKILL"});
    log.debug(label, `fkill sent (${signal}) to ${ptyProcess.pid}`);
    return true;
  } catch (err) {
    log.error(label, `fkill failed`, err);
    return false;
  }
}
```

No more “signal unsupported” warnings—`fkill` delegates to **`taskkill` on Windows** and normal signals elsewhere.

---

## 4 ️⃣ Tail command helper – in `utils.ts`

```ts
import tailCmd from "powershell-tail";   // ⬅ new

export function getTailCommand(logFilePath: string | null): string | null {
  if (!logFilePath) return null;
  return process.platform === "win32"
    ? tailCmd({file: logFilePath, follow: true, lines: 10})   // returns the PS cmd
    : `tail -f "${logFilePath}"`;
}
```

Then in **`_startProcess`** just replace the old inline ternary:

```ts
const tail_command = getTailCommand(logFilePath);
```

---

## 5 ️⃣ Add Windows to CI – `.github/workflows/ci.yml`

```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      # …identical steps…
```

*(`node-pty@1.x` ships pre-built binaries, so no extra toolchain is needed.)*

---

## 6 ️⃣ Reserved-filename edge-case (very quick win)  
Your `sanitizeLabelForFilename` doesn’t catch Windows reserved names (`CON`, `PRN`, `NUL`, etc.). Add this single guard at the end:

```ts
if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(sanitized))
  sanitized = `file_${sanitized}`;
```

---

### Quick smoke-test checklist (manual)

1. **`npm run build`** ▶ on a Windows 11 VM – should succeed, no `node-gyp` compile.  
2. **`npx mcp-pm`**  
   - Start a dummy server:  
     `{"tool":"start_process", … "command":"npm", "args":["run","dev"] …}`  
   - Stop it – verify `SIGTERM` and fallback **work**.  
3. View the “tail” hint → should output PowerShell flavour.  
4. Run the new CI job – pass ✅.

---

### TL;DR  
With three tiny cross-platform utilities and a CI matrix entry, **mcp-pm becomes first-class on Windows**—no new home-grown abstractions, no hidden dragons.  

Ready to ship… or do you spot another lurking gremlin? 😉