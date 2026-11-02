# TermX

A MobaXterm-style terminal workspace with a modern UI. Built with Electron, xterm.js, node-pty and ssh2.

## Run

```bash
npm install
npm start
```

> npm 11 skips install scripts by default. If `node_modules/electron/dist` is missing after install, run `node node_modules/electron/install.js` once.

## Features

- **Local terminals**: PowerShell 7, Windows PowerShell, CMD, Git Bash and WSL distros are detected automatically (ConPTY, truecolor, WebGL renderer).
- **SSH sessions**: password, private key or the Windows OpenSSH agent. Hosts are verified trust-on-first-use, with a warning if a key changes.
- **Saved sessions**: folders, colors and search. Passwords are encrypted with Windows DPAPI (Electron `safeStorage`).
- **Quick connect**: type `user@host:port` (or `ssh user@host -p 2222`) in the title bar.
- **SFTP browser**: follows the active SSH tab. Upload (button or drag and drop, including folders), download (files and folders), rename, delete, new file or folder, and *open/edit*, which opens a file in its default app and uploads it again on each save.
- **Live server stats** in the status bar for Linux hosts: CPU load, RAM, disk and uptime.
- **Split panes**: split any tab right or down, as many times as you like. Mix shells and SSH sessions in one tab, drag dividers to resize (double-click resets to 50/50), and move between panes with Alt+Arrow keys.
- **Multi-exec**: sends your keystrokes to every connected pane at once.
- **Import connections** from MobaXterm (found automatically, or an exported `.mxtsessions` file), PuTTY (registry or `.reg` export), your OpenSSH `~/.ssh/config`, or a TermX export. Folders and key files carry over; connections you already have are skipped. **Export** writes your sessions to a JSON file (never passwords) to move them to another computer.
- **Grep** (like IntelliJ's Grep Console): a filter panel under any terminal (Ctrl+Shift+G or the Grep button in the status bar). Show lines containing some text, hide lines containing other text, with match-case and regex options. New output is filtered live as it arrives; **Refresh** re-runs the filter over everything in the terminal, **Clear** starts fresh from new output, and clicking a line jumps to it in the terminal. ERROR and WARN lines are colour-coded, and recent filters are remembered.
- **Search**: one box that searches the scrollback of every open terminal plus your saved sessions and flows, with match-case and regex options. Results update as new output arrives; click a line to jump to it and highlight the match. Selected text and search matches have their own colors, which you can change in Settings → Highlight colors.
- **Flows** (like MobaXterm macros): record what you type in a terminal, or build steps by hand: *Type*, *Press key*, *Wait* and *Wait for text*. Run a flow in one pane, every pane of a tab or every connected terminal. `{{name}}` in a step asks for a value when the flow runs, and a saved session can run a flow automatically after it connects.
- Command palette, find in terminal, tabs you can rename and drag, 6 terminal themes, font and cursor settings, and copy-on-select / right-click paste.

## Shortcuts

| Action | Keys |
|---|---|
| Command palette | Ctrl+Shift+P |
| New terminal / SSH session | Ctrl+Shift+T / Ctrl+Shift+N |
| Split right / down | Ctrl+Shift+D / Ctrl+Shift+E |
| Move between panes | Alt+Arrow keys |
| Close pane | Ctrl+Shift+W |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab, Alt+1…9 |
| Copy / paste | Ctrl+Shift+C / Ctrl+Shift+V |
| Find in terminal | Ctrl+Shift+F |
| Search everything | Ctrl+Shift+S |
| Grep (filter output) | Ctrl+Shift+G |
| Multi-exec | Ctrl+Shift+M |
| Record / stop recording a flow | Ctrl+Shift+R |
| Toggle sidebar | Ctrl+Shift+B |
| Zoom | Ctrl+= / Ctrl+- / Ctrl+0 |

## Layout

- `src/main.js`: the main process (PTYs, SSH/SFTP, session storage, host keys)
- `src/preload.js`: the IPC bridge exposed as `window.termx`
- `src/renderer/`: the UI (`app.js`, `styles.css`, `themes.js`, `icons.js`)

Data lives in `%APPDATA%\TermX` (`sessions.json`, `known_hosts.json`, `flows.json`).
