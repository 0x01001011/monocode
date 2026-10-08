# Open remote projects and files in an external editor

Let "Open in editor" work for projects on an SSH machine, and add it to file tabs, the file tree and worktree rows, opening the file at the current line.

## Decisions
- Today `open_in_external_editor` runs `code <local folder>` only. A `remote://` cwd is routed by `invokeWorkspace` to the remote host, which rejects the command ("isn't available for projects on another machine yet"). There is no file or line targeting, and the only entry is the project menu.
- New Tauri command `open_remote_in_external_editor`; the local command is unchanged. The webview parses the `remote://` path with `parseRemotePath` and sends plain data, so `invokeWorkspace` never sees a `remote://` argument.
- Rust finds the machine by `environmentId` in its own registry. The webview never supplies the SSH host. A machine without an `ssh` target (plain HTTP endpoint) returns "This machine has no SSH address to open in an editor."
- Editors offered for remote projects: VS Code, VS Code Insiders and Cursor (`--remote`, `--folder-uri`, `--goto`), and Zed (`ssh://` URL). VSCodium, Windsurf and Sublime Text are not offered: remote support is unverified. `ExternalEditor` gains `remote: bool` and the menu filters on it.
- Custom SSH port: Zed takes it in the URL. For VS Code and Cursor the `ssh-remote+` authority has no documented port or ProxyJump encoding, so a machine with a port returns "VS Code needs the port in ~/.ssh/config. Add a Host entry with Port and connect with that alias." No undocumented encodings.
- Out of scope: the multi-worktree `.code-workspace`, writing SSH aliases, `code-server`, a FileSystemProvider extension, JetBrains Gateway.

## Contract
- `open_remote_in_external_editor { editorId, environmentId, hostPath, kind: "folder" | "file", line?, column? }`. `hostPath` is absolute POSIX (or a Windows drive path); `line` and `column` are 1-based.
- TypeScript: `openRemoteInExternalEditor(editorId, remotePath, target?)` in `platform/tauri/fs.ts` beside `openInExternalEditor`; it returns the same errors as strings for `FileActionError`.
- `list_external_editors` returns `{ id, name, remote }`; `remote` is true only for the four editors above.
- Local files: `open_in_external_editor` gains optional `file`, `line`, `column`. The VS Code family gets `<cwd> --goto=<file>:<line>:<column>`, Zed gets `<file>:<line>:<column>`, other editors get the file path with no line. Without `file` it behaves exactly as today.

## Rust (`external_editor.rs`)
- Pure `remote_editor_args(editor, authority, path, kind, line, column) -> Result<Vec<String>, String>`, unit tested, with no process spawning.
- VS Code family, folder: `-n`, `--folder-uri=vscode-remote://ssh-remote+<authority>/<path>`. File: `--remote=ssh-remote+<authority>`, `--goto=<path>[:<line>[:<column>]]`. Always the `--flag=value` form: the VS Code CLI documents no `--` separator, so values must never parse as flags.
- Zed: `ssh://<authority>[:<port>]<path>`, with `:<line>:<column>` appended for a file.
- Authority is the machine's `user@host`, checked with the existing `validate_target` and then restricted to `[A-Za-z0-9._@-]` with no leading `-`. IPv6 literals and anything else are refused with a message.
- The path goes into the URI with `url::Url::path_segments_mut` (encodes space, `%`, unicode, quotes; verified by probe on url 2.5.8). A path containing NUL, CR or LF is refused.
- Launcher, reusing `resolve_editor`: Windows keeps preferring the installed `Code.exe`/`Cursor.exe`/`Zed.exe` over `.cmd` shims. Linux uses the resolved command. macOS: use the editor's bundled CLI (`<App>/Contents/Resources/app/bin/code` for VS Code and Insiders; Cursor's equivalent; `<App>/Contents/MacOS/cli` for Zed) because it forwards to a running instance; fall back to `open -n -a <App> --args <args>` only when the bundled CLI is missing. Spawned with stdin/stdout/stderr null and `apply_gui_env`, as today.
- Errors reuse the existing style: "<Editor> is no longer installed.", "Could not open <Editor>: <os error>".

## Desktop
- `useProjectMenu.tsx`: for a remote project path call the new command; list only editors with `remote`; the submenu shows "No remote-capable editors found" when empty.
- New "Open in Editor" submenu on file tabs (`SurfaceTabs.tsx`) and the file-tree context menu (`FileTree.tsx`), for local and remote files, listing editors from a lazily loaded cache (`editorMenu.ts`). Worktree rows are a follow-up; the file tree's folder entries already cover a worktree root. For a local file it uses the existing editor launch with `--goto` (VS Code family) so the line is honored there too. The last editor used (localStorage) is listed first in the submenu.
- Failures show through `FileActionError`; nothing is silently ignored.

## Verification
- Rust: argument fixtures for folder and file, spaces, `%`, `&`, quotes, unicode, a leading `-` in host and path, a custom port per editor, IPv6, NUL and newline, plus a test that unsupported editors and machines without `ssh` fail before spawning.
- TypeScript: `parseRemotePath` to request mapping, the `remote` filter, the "last used editor" choice, and that no `remote://` argument reaches `invokeWorkspace`.
- Full `vitest run`, `cargo test`, `cargo clippy -D warnings` (the repo's `check:rust`).
- Manual, not automatable: on `kgpu`, VS Code folder and file at a line, Cursor, Zed; Windows with `Code.exe`; macOS with no `code` on PATH; a machine with a custom port. Also confirm `--remote`, `--folder-uri` and `--goto` work together, since the installed `code --help` lists only `--goto`, `-n` and `-r`.

## Risks
- `--remote` and `--folder-uri` are hidden VS Code flags found in source, not documented in `--help`; a VS Code update could change them.
- VS Code needs the Microsoft Remote-SSH extension installed, which in turn installs vscode-server on the host and needs outbound HTTPS from it. The app cannot check this; a failed connection shows inside VS Code.
- macOS bundled-CLI paths for Cursor and Zed are assumed from the VS Code layout and must be checked on a machine that has them.
