**Exploring node-pty behavior**

The user is asking about detecting user input prompts while listening to output events with node-pty. From what I know, pseudo-terminals don’t usually send a specific character or event when they’re waiting for input. However, in some cases, programs might send a standard prompt, like a newline or specific control sequence, to indicate that they’re “waiting.” Depending on the terminal


**Considering input detection**

There's no built-in, standardized "input requested" signal in pseudo-terminals; it's usually program-specific. Interactive programs like shells tend to show prompts when they need input, but that's not always consistent. With node-pty, there's no direct "waiting for input" event either. However, you could detect input readiness by watching when the terminal is ready for reading or writing, checking for blocked reads, or using specific system calls, like monitoring STDIN or file descriptors with tools like poll/epoll.

**Exploring terminal behaviors for prompts**

Some terminals, like iTerm2 and VSCode with integrated shells, use specific control sequences to mark prompt states. iTerm2, for instance, uses "Shell Integration" sequences like OSC 133 to signal the start of a prompt or command. While this isn’t the default behavior, you can configure shells like zsh or bash to send these sequences. I'll quickly look up "OSC 133 prompt start" and "VSCode shell integration" to see if this gives more insight.


**Understanding prompt detection in pseudo-terminals**

There's no universal "input requested" signal in pseudo-terminals; detecting prompts generally requires heuristic methods. Although tools like `strace` or `fcntl` can approximate this, it's more common to use regex patterns to match typical prompt indicators (e.g., `#`, `$`, `>`, `?`). Tools like `Expect` and `pexpect` rely on user-defined patterns. Shells may also use custom prompts or sequences (e.g., PS1 with control characters or VTE sequences). I'll provide details and citations on detecting prompts via `node-pty` and other techniques.


Thought for 31 seconds


Below is the bad news, the good news, and a battle-tested workaround—all wrapped in a brisk step-by-step format so your AI agent can wire it in with zero hand-holding.

## TL;DR (a.k.a “Tell it like it is”)

*Pseudo-terminals themselves never send a magic “🎤 Your turn!” byte.* They just shovel whatever the child process writes; when the process calls `read()` on **stdin**, the kernel blocks silently—no extra character, no extra event. ([GitHub][1], [Stack Overflow][2])
**But** you *can* create your own “I-need-input” beacon by teaching the shell to emit special escape sequences (OSC 133 “shell-integration” marks). Listen for those sequences in `pty.onData()` and you’ll get crisp, deterministic “prompt-started / prompt-ended / command-finished” events—exactly what modern terminals and IDEs use. ([Visual Studio Code][3], [Microsoft Learn][4], [iTerm2][5], [GitHub][6])

---

## 1 · Why there’s no built-in signal

1. **TTY API is ancient** – It predates even DOS prompts, so the master side gets no hint when the slave blocks on `read()`. ([Stack Overflow][2])
2. Node-pty therefore exposes only `data`, `exit`, `close`, etc.—there’s no “waiting” event. ([GitHub][1])
3. Tools like **Expect/pexpect** solve this by regex-matching the prompt text, not by reading a control code. ([Stack Overflow][7], [pexpect.readthedocs.io][8])

---

## 2 · Modern solution: OSC 133 shell-integration marks

Most new-school terminals (VS Code, Windows Terminal, WezTerm, Kitty, iTerm2, even tmux patches) understand a tiny spec based on **OSC 133** control sequences: ([Visual Studio Code][3], [Microsoft Learn][4], [WezTerm - Wez's Terminal Emulator][9], [sw.kovidgoyal.net][10], [GitHub][6])

| Sequence                    | Meaning              | When you should fire your “need input” callback                |
| --------------------------- | -------------------- | -------------------------------------------------------------- |
| `ESC ] 133 ; A ST`          | **Prompt start**     | Arrival of this means the shell is about to draw the prompt.   |
| `ESC ] 133 ; B ST`          | **Prompt end**       | Right after this, the shell waits for the user → *input time!* |
| `ESC ] 133 ; C ST`          | **Command pre-exec** | Optional “command is about to run”.                            |
| `ESC ] 133 ; D ; <exit> ST` | **Command finished** | Good for timing and exit-code tracking.                        |

*(`ESC` is `\x1b`, `ST` is `\x1b\\` or `\x07`.)*

### How to inject the marks

```bash
# Bash / Zsh example (put in ~/.bashrc or ~/.zshrc)
function _osc133_prompt_start { printf '\e]133;A\a'; }
function _osc133_prompt_end   { printf '\e]133;B\a'; }
PROMPT_COMMAND='_osc133_prompt_start'   # Bash
PS1='\u@\h:\w\$ '                       # your usual prompt
PS1="$PS1$(_osc133_prompt_end)"         # add the end mark
```

Fish, PowerShell, and others have equivalents—docs linked above. ([Microsoft Learn][4], [Microsoft for Developers][11])

---

## 3 · Node-pty side: Tie it all together

```ts
import { spawn } from 'node-pty';

const pty = spawn('bash', [], { name: 'xterm-256color', cols: 80, rows: 30 });

pty.onData((chunk) => {
  if (chunk.includes('\x1b]133;B')) {
    // Prompt ended → user input expected
    emit('awaiting-input');
  } else if (chunk.includes('\x1b]133;C')) {
    emit('command-start');
  } else if (chunk.match(/\x1b]133;D;(\d+)/)) {
    const exit = RegExp.$1;
    emit('command-done', Number(exit));
  }
});
```

*Tip*: parse incrementally—an OSC may arrive split across chunks. Buffer until you see `ST` (`\x1b\\` or `\x07`).

---

## 4 · Fallback heuristics (when you can’t touch the prompt)

* **Regex prompt sniffing** – Look for `[$#>] $` after a newline. Works for plain `sh`, `bash`, `zsh`, etc., but fails on localized or custom prompts. ([Stack Overflow][7])
* **Custom sentinel** – Tell scripts under your control to print `@@READY@@`, then regex for that.
* **System-level hacks** – `strace`/`ptrace` to watch `read()` syscalls, but that’s heavyweight and non-portable. ([Stack Overflow][12])

---

## 5 · Next steps

1. **Add OSC 133 to your dev container images** so any shell your AI spins up emits the marks.
2. **Wrap the pattern above** in a tiny TypeScript library (`detectPrompt.ts`) and share it across agents.
3. **Cache command timing** (prompt→C, C→D) to auto-tune progress indicators or decide when to fall back to static analysis.

---

## Final thought

The kernel isn’t going to tap you on the shoulder, but with a one-liner in your shell prompt you get a rock-solid, cross-terminal “now it’s your turn” signal—and your AI agents will look clairvoyant instead of clueless. Ready to sprinkle some OSC 133 magic into your workflow?

[1]: https://github.com/microsoft/node-pty/issues/56?utm_source=chatgpt.com "[Question] Is it possible to be notified when a command is executed"
[2]: https://stackoverflow.com/questions/63394927/what-does-the-tty-do-when-a-process-asks-for-input-or-outputs-to-the-screen?utm_source=chatgpt.com "linux - What does the tty do when a process asks for input or outputs ..."
[3]: https://code.visualstudio.com/docs/terminal/shell-integration?utm_source=chatgpt.com "Terminal Shell Integration - Visual Studio Code"
[4]: https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration?utm_source=chatgpt.com "Shell integration in the Windows Terminal | Microsoft Learn"
[5]: https://iterm2.com/documentation-escape-codes.html?utm_source=chatgpt.com "Proprietary Escape Codes - Documentation - iTerm2"
[6]: https://github.com/tmux/tmux/issues/3064?utm_source=chatgpt.com "OSC 133 (shell integration / semantic prompt) support #3064 - GitHub"
[7]: https://stackoverflow.com/questions/62352571/how-do-you-get-pexpect-to-trigger-on-process-expect-for-the-linux-command-l?utm_source=chatgpt.com "python - How do you get pexpect to trigger on process.expect(\"$\") for ..."
[8]: https://pexpect.readthedocs.io/en/stable/overview.html?utm_source=chatgpt.com "API Overview — Pexpect 4.8 documentation - Read the Docs"
[9]: https://wezterm.org/shell-integration.html?utm_source=chatgpt.com "Shell Integration - Wez's Terminal Emulator"
[10]: https://sw.kovidgoyal.net/kitty/shell-integration/?utm_source=chatgpt.com "Shell integration - kitty - Kovid's software projects"
[11]: https://devblogs.microsoft.com/commandline/shell-integration-in-the-windows-terminal/?utm_source=chatgpt.com "Shell integration in the Windows Terminal - Microsoft Developer Blogs"
[12]: https://stackoverflow.com/questions/18107541/detecting-when-a-child-process-is-waiting-for-input?utm_source=chatgpt.com "Detecting when a child process is waiting for input - Stack Overflow"
