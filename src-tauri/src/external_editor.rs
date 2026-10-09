use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[cfg(target_os = "macos")]
use crate::dirs_home;
use crate::{
    fs::expand_home,
    harness,
    remote::{machine_ssh, RemoteConnections},
    remote_ssh::{validate_target, SshTarget},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    id: &'static str,
    name: &'static str,
    /// Can open a project on an SSH machine; only verified editors say yes.
    remote: bool,
}

/// How an editor takes a file location on its command line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    /// VS Code and its forks: `--goto=<file>:<line>:<column>`.
    Code,
    /// Zed: `<file>:<line>:<column>`.
    Zed,
    /// The file path alone.
    Other,
}

/// What a remote open targets.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenKind {
    Folder,
    File,
}

struct EditorDefinition {
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    family: Family,
    remote: bool,
    #[cfg(target_os = "macos")]
    mac_apps: &'static [&'static str],
    /// The editor's own command inside its app bundle; unlike `open`, it
    /// hands arguments to an editor that is already running.
    #[cfg(target_os = "macos")]
    mac_cli: &'static [&'static str],
    #[cfg(windows)]
    windows_paths: &'static [(&'static str, &'static str)],
}

const EDITORS: &[EditorDefinition] = &[
    EditorDefinition {
        id: "vscode",
        name: "Visual Studio Code",
        commands: &["code"],
        family: Family::Code,
        remote: true,
        #[cfg(target_os = "macos")]
        mac_apps: &["Visual Studio Code.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/Resources/app/bin/code"],
        #[cfg(windows)]
        windows_paths: &[
            ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
            ("ProgramFiles", "Microsoft VS Code/Code.exe"),
            ("ProgramFiles(x86)", "Microsoft VS Code/Code.exe"),
        ],
    },
    EditorDefinition {
        id: "vscode-insiders",
        name: "Visual Studio Code Insiders",
        commands: &["code-insiders"],
        family: Family::Code,
        remote: true,
        #[cfg(target_os = "macos")]
        mac_apps: &["Visual Studio Code - Insiders.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/Resources/app/bin/code"],
        #[cfg(windows)]
        windows_paths: &[
            (
                "LOCALAPPDATA",
                "Programs/Microsoft VS Code Insiders/Code - Insiders.exe",
            ),
            (
                "ProgramFiles",
                "Microsoft VS Code Insiders/Code - Insiders.exe",
            ),
            (
                "ProgramFiles(x86)",
                "Microsoft VS Code Insiders/Code - Insiders.exe",
            ),
        ],
    },
    EditorDefinition {
        id: "vscodium",
        name: "VSCodium",
        commands: &["codium"],
        family: Family::Code,
        remote: false,
        #[cfg(target_os = "macos")]
        mac_apps: &["VSCodium.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/Resources/app/bin/codium"],
        #[cfg(windows)]
        windows_paths: &[
            ("LOCALAPPDATA", "Programs/VSCodium/VSCodium.exe"),
            ("ProgramFiles", "VSCodium/VSCodium.exe"),
            ("ProgramFiles(x86)", "VSCodium/VSCodium.exe"),
        ],
    },
    EditorDefinition {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        family: Family::Code,
        remote: true,
        #[cfg(target_os = "macos")]
        mac_apps: &["Cursor.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/Resources/app/bin/cursor"],
        #[cfg(windows)]
        windows_paths: &[
            ("LOCALAPPDATA", "Programs/cursor/Cursor.exe"),
            ("ProgramFiles", "Cursor/Cursor.exe"),
            ("ProgramFiles(x86)", "Cursor/Cursor.exe"),
        ],
    },
    EditorDefinition {
        id: "zed",
        name: "Zed",
        commands: &["zed"],
        family: Family::Zed,
        remote: true,
        #[cfg(target_os = "macos")]
        mac_apps: &["Zed.app", "Zed Preview.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/MacOS/cli"],
        #[cfg(windows)]
        windows_paths: &[
            ("LOCALAPPDATA", "Programs/Zed/Zed.exe"),
            ("ProgramFiles", "Zed/Zed.exe"),
        ],
    },
    EditorDefinition {
        id: "windsurf",
        name: "Windsurf",
        commands: &["windsurf"],
        family: Family::Code,
        remote: false,
        #[cfg(target_os = "macos")]
        mac_apps: &["Windsurf.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/Resources/app/bin/windsurf"],
        #[cfg(windows)]
        windows_paths: &[
            ("LOCALAPPDATA", "Programs/Windsurf/Windsurf.exe"),
            ("ProgramFiles", "Windsurf/Windsurf.exe"),
        ],
    },
    EditorDefinition {
        id: "sublime-text",
        name: "Sublime Text",
        commands: &["subl", "sublime_text"],
        family: Family::Other,
        remote: false,
        #[cfg(target_os = "macos")]
        mac_apps: &["Sublime Text.app"],
        #[cfg(target_os = "macos")]
        mac_cli: &["Contents/SharedSupport/bin/subl"],
        #[cfg(windows)]
        windows_paths: &[
            ("ProgramFiles", "Sublime Text/sublime_text.exe"),
            ("ProgramFiles(x86)", "Sublime Text/sublime_text.exe"),
        ],
    },
];

enum EditorLauncher {
    Command(PathBuf),
    #[cfg(target_os = "macos")]
    MacApp(PathBuf),
}

fn definition(id: &str) -> Option<&'static EditorDefinition> {
    EDITORS.iter().find(|editor| editor.id == id)
}

#[cfg(target_os = "macos")]
fn installed_mac_app(editor: &EditorDefinition) -> Option<PathBuf> {
    let user_applications = dirs_home().map(|home| PathBuf::from(home).join("Applications"));
    editor.mac_apps.iter().find_map(|name| {
        user_applications
            .as_ref()
            .map(|root| root.join(name))
            .filter(|path| path.is_dir())
            .or_else(|| {
                let path = Path::new("/Applications").join(name);
                path.is_dir().then_some(path)
            })
    })
}

#[cfg(windows)]
fn installed_windows_app(editor: &EditorDefinition) -> Option<PathBuf> {
    editor
        .windows_paths
        .iter()
        .find_map(|(variable, relative)| {
            let root = std::env::var_os(variable)?;
            let path = PathBuf::from(root).join(relative);
            path.is_file().then_some(path)
        })
}

fn resolve_editor(editor: &EditorDefinition) -> Option<EditorLauncher> {
    #[cfg(target_os = "macos")]
    if let Some(path) = installed_mac_app(editor) {
        return Some(EditorLauncher::MacApp(path));
    }

    #[cfg(windows)]
    if let Some(path) = installed_windows_app(editor) {
        return Some(EditorLauncher::Command(path));
    }

    editor
        .commands
        .iter()
        .find_map(|command| harness::resolve_gui_binary(command))
        .map(EditorLauncher::Command)
}

fn installed_editors_sync() -> Vec<ExternalEditor> {
    EDITORS
        .iter()
        .filter(|editor| resolve_editor(editor).is_some())
        .map(|editor| ExternalEditor {
            id: editor.id,
            name: editor.name,
            remote: editor.remote,
        })
        .collect()
}

#[tauri::command(async)]
pub async fn list_external_editors() -> Result<Vec<ExternalEditor>, String> {
    tauri::async_runtime::spawn_blocking(installed_editors_sync)
        .await
        .map_err(|error| error.to_string())
}

fn location(line: Option<u32>, column: Option<u32>) -> String {
    match (line.filter(|n| *n > 0), column.filter(|n| *n > 0)) {
        (Some(line), Some(column)) => format!(":{line}:{column}"),
        (Some(line), None) => format!(":{line}"),
        (None, _) => String::new(),
    }
}

/// Arguments for opening a local folder, and a file in it at a line.
fn local_editor_args(
    editor: &EditorDefinition,
    cwd: &Path,
    file: Option<&str>,
    line: Option<u32>,
    column: Option<u32>,
) -> Vec<String> {
    let mut args = vec![cwd.to_string_lossy().into_owned()];
    if let Some(file) = file {
        args.push(match editor.family {
            Family::Code => format!("--goto={file}{}", location(line, column)),
            Family::Zed => format!("{file}{}", location(line, column)),
            Family::Other => file.to_string(),
        });
    }
    args
}

/// The `user@host` an editor may be pointed at. Narrower than what SSH itself
/// accepts: the address ends up inside a URI and an option value.
fn remote_authority(ssh: &SshTarget) -> Result<String, String> {
    let target = validate_target(&ssh.target, ssh.port)?;
    if target.starts_with('-')
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._@-".contains(&b))
    {
        return Err(
            "This SSH address cannot be opened in an editor. Use a plain user@host name without a port or brackets."
                .into(),
        );
    }
    Ok(target)
}

/// A normalized absolute POSIX path, and its percent-encoded form for a URI.
fn remote_path(path: &str) -> Result<(String, String), String> {
    if !path.starts_with('/') {
        return Err(
            "Only absolute paths on Linux or macOS machines can be opened in an editor.".into(),
        );
    }
    if path.chars().any(|c| matches!(c, '\0' | '\n' | '\r')) {
        return Err("The path contains a control character.".into());
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| matches!(*s, "." | "..")) {
        return Err("The path must not contain . or .. segments.".into());
    }
    if segments.is_empty() {
        return Ok(("/".into(), "/".into()));
    }
    let mut url = url::Url::parse("x:///").map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "The path cannot be encoded.".to_string())?
        .clear()
        .extend(&segments);
    Ok((format!("/{}", segments.join("/")), url.path().to_string()))
}

/// Arguments that open a folder or file on an SSH machine. Pure, so it can be
/// tested without an editor. Values always use the `--flag=value` form: the VS
/// Code CLI documents no `--` separator, so nothing here may parse as a flag.
fn remote_editor_args(
    editor: &EditorDefinition,
    ssh: &SshTarget,
    path: &str,
    kind: OpenKind,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<Vec<String>, String> {
    if !editor.remote {
        return Err(format!(
            "{} does not support opening remote projects yet.",
            editor.name
        ));
    }
    let authority = remote_authority(ssh)?;
    if line == Some(0) || (line.is_some() && column == Some(0)) {
        return Err("Line and column numbers start at 1.".into());
    }
    let (raw, encoded) = remote_path(path)?;
    let at = if kind == OpenKind::File {
        location(line, column)
    } else {
        String::new()
    };
    match editor.family {
        Family::Code => {
            if ssh.port.is_some() {
                return Err(format!(
                    "{} needs the SSH port in ~/.ssh/config. Add a Host entry with Port and connect with that alias.",
                    editor.name
                ));
            }
            Ok(match kind {
                OpenKind::Folder => vec![
                    "-n".into(),
                    format!("--folder-uri=vscode-remote://ssh-remote+{authority}{encoded}"),
                ],
                OpenKind::File => vec![
                    format!("--remote=ssh-remote+{authority}"),
                    format!("--goto={raw}{at}"),
                ],
            })
        }
        Family::Zed => {
            let port = ssh.port.map(|port| format!(":{port}")).unwrap_or_default();
            Ok(vec![format!("ssh://{authority}{port}{encoded}{at}")])
        }
        Family::Other => Err(format!(
            "{} does not support opening remote projects yet.",
            editor.name
        )),
    }
}

/// Starts the editor. `plain` is a bare local folder open, which keeps using
/// `open -a` on macOS; anything with options goes through the editor's own
/// command so a running editor receives them.
fn spawn_editor(
    editor: &EditorDefinition,
    launcher: EditorLauncher,
    args: Vec<String>,
    plain: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = match launcher {
        EditorLauncher::MacApp(app) if plain => {
            let mut command = Command::new("/usr/bin/open");
            command.arg("-a").arg(app).args(&args);
            command
        }
        EditorLauncher::MacApp(app) => {
            match editor
                .mac_cli
                .iter()
                .map(|relative| app.join(relative))
                .find(|cli| cli.is_file())
            {
                Some(cli) => {
                    let mut command = Command::new(cli);
                    command.args(&args);
                    command
                }
                None => {
                    let mut command = Command::new("/usr/bin/open");
                    command
                        .arg("-n")
                        .arg("-a")
                        .arg(app)
                        .arg("--args")
                        .args(&args);
                    command
                }
            }
        }
        EditorLauncher::Command(program) => {
            let mut command = Command::new(program);
            command.args(&args);
            command
        }
    };

    #[cfg(not(target_os = "macos"))]
    let mut command = {
        let _ = plain;
        match launcher {
            EditorLauncher::Command(program) => {
                let mut command = Command::new(program);
                command.args(&args);
                command
            }
        }
    };

    harness::apply_gui_env(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open {}: {error}", editor.name))
}

fn launch_editor_sync(
    editor_id: &str,
    cwd: &str,
    file: Option<&str>,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let editor = definition(editor_id).ok_or_else(|| "Unknown external editor.".to_string())?;
    let cwd = expand_home(cwd);
    if !cwd.is_dir() {
        return Err(format!("{} is not a folder.", cwd.display()));
    }
    let launcher =
        resolve_editor(editor).ok_or_else(|| format!("{} is no longer installed.", editor.name))?;
    let args = local_editor_args(editor, &cwd, file, line, column);
    spawn_editor(editor, launcher, args, file.is_none())
}

fn launch_remote_sync(
    editor_id: &str,
    ssh: &SshTarget,
    path: &str,
    kind: OpenKind,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let editor = definition(editor_id).ok_or_else(|| "Unknown external editor.".to_string())?;
    let args = remote_editor_args(editor, ssh, path, kind, line, column)?;
    let launcher =
        resolve_editor(editor).ok_or_else(|| format!("{} is no longer installed.", editor.name))?;
    spawn_editor(editor, launcher, args, false)
}

#[tauri::command(async)]
pub async fn open_in_external_editor(
    editor_id: String,
    cwd: String,
    file: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_editor_sync(&editor_id, &cwd, file.as_deref(), line, column)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens a folder or file on an SSH machine. The machine's address comes from
/// this app's own registry, never from the webview.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn open_remote_in_external_editor(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    editor_id: String,
    environment_id: String,
    host_path: String,
    kind: OpenKind,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let ssh = machine_ssh(&app, &state, &environment_id)?;
    launch_remote_sync(&editor_id, &ssh, &host_path, kind, line, column)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_ids_and_names_are_unique() {
        let mut ids = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for editor in EDITORS {
            assert!(ids.insert(editor.id), "duplicate editor id: {}", editor.id);
            assert!(
                names.insert(editor.name),
                "duplicate editor name: {}",
                editor.name
            );
            assert!(!editor.commands.is_empty());
        }
    }

    #[test]
    fn unknown_editor_is_rejected_before_launch() {
        let error = launch_editor_sync("not-an-editor", ".", None, None, None).unwrap_err();
        assert_eq!(error, "Unknown external editor.");
    }

    fn ssh(target: &str, port: Option<u16>) -> SshTarget {
        SshTarget {
            target: target.into(),
            port,
            remote_port: 3774,
        }
    }

    fn remote(
        editor: &str,
        target: &str,
        port: Option<u16>,
        path: &str,
        kind: OpenKind,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<Vec<String>, String> {
        remote_editor_args(
            definition(editor).unwrap(),
            &ssh(target, port),
            path,
            kind,
            line,
            column,
        )
    }

    fn folder(
        editor: &str,
        target: &str,
        port: Option<u16>,
        path: &str,
    ) -> Result<Vec<String>, String> {
        remote(editor, target, port, path, OpenKind::Folder, None, None)
    }

    #[test]
    fn only_verified_editors_are_remote() {
        let mut ids: Vec<_> = EDITORS.iter().filter(|e| e.remote).map(|e| e.id).collect();
        ids.sort();
        assert_eq!(ids, ["cursor", "vscode", "vscode-insiders", "zed"]);
    }

    #[test]
    fn editor_list_reports_remote_capability() {
        let json = serde_json::to_string(&ExternalEditor {
            id: "zed",
            name: "Zed",
            remote: true,
        })
        .unwrap();
        assert_eq!(json, r#"{"id":"zed","name":"Zed","remote":true}"#);
    }

    #[test]
    fn code_folder_uses_a_folder_uri_in_a_new_window() {
        assert_eq!(
            folder("vscode", "k@kgpu", None, "/home/k/proj").unwrap(),
            [
                "-n",
                "--folder-uri=vscode-remote://ssh-remote+k@kgpu/home/k/proj"
            ]
        );
        assert_eq!(
            folder("cursor", "kgpu", None, "/home/k/proj/").unwrap(),
            [
                "-n",
                "--folder-uri=vscode-remote://ssh-remote+kgpu/home/k/proj"
            ]
        );
    }

    #[test]
    fn code_file_uses_remote_and_goto() {
        let file = |line, column| {
            remote(
                "vscode",
                "k@kgpu",
                None,
                "/home/k/a.rs",
                OpenKind::File,
                line,
                column,
            )
            .unwrap()
        };
        assert_eq!(
            file(None, None),
            ["--remote=ssh-remote+k@kgpu", "--goto=/home/k/a.rs"]
        );
        assert_eq!(
            file(Some(12), None),
            ["--remote=ssh-remote+k@kgpu", "--goto=/home/k/a.rs:12"]
        );
        assert_eq!(
            file(Some(12), Some(3)),
            ["--remote=ssh-remote+k@kgpu", "--goto=/home/k/a.rs:12:3"]
        );
        // A column without a line has nothing to attach to.
        assert_eq!(
            file(None, Some(3)),
            ["--remote=ssh-remote+k@kgpu", "--goto=/home/k/a.rs"]
        );
    }

    #[test]
    fn folder_uri_encodes_awkward_paths() {
        let args = folder("vscode", "k@kgpu", None, "/home/k/my proj/50%/\u{e9}&'#?").unwrap();
        assert_eq!(
            args[1],
            "--folder-uri=vscode-remote://ssh-remote+k@kgpu/home/k/my%20proj/50%25/%C3%A9&'%23%3F"
        );
    }

    #[test]
    fn zed_uses_an_ssh_url_with_the_port_and_location() {
        assert_eq!(
            folder("zed", "k@kgpu", None, "/home/k/proj").unwrap(),
            ["ssh://k@kgpu/home/k/proj"]
        );
        assert_eq!(
            folder("zed", "k@kgpu", Some(2222), "/home/k/proj").unwrap(),
            ["ssh://k@kgpu:2222/home/k/proj"]
        );
        assert_eq!(
            remote(
                "zed",
                "k@kgpu",
                Some(2222),
                "/home/k/a b.rs",
                OpenKind::File,
                Some(12),
                Some(3)
            )
            .unwrap(),
            ["ssh://k@kgpu:2222/home/k/a%20b.rs:12:3"]
        );
    }

    #[test]
    fn code_cannot_carry_a_custom_port() {
        for editor in ["vscode", "vscode-insiders", "cursor"] {
            let error = folder(editor, "k@kgpu", Some(2222), "/home/k/proj").unwrap_err();
            assert!(error.contains("~/.ssh/config"), "{editor}: {error}");
        }
    }

    #[test]
    fn hostile_or_unusual_hosts_are_refused() {
        for target in [
            "-oProxyCommand=touch /tmp/x",
            "-J evil",
            "k@kgpu:22",
            "[::1]",
            "k@@kgpu",
            "k@\nkgpu",
            "k@kgpu\r\n--evil",
            "k kgpu",
            "k@kg$pu",
            "",
        ] {
            assert!(
                folder("vscode", target, None, "/home/k/proj").is_err(),
                "{target:?} should be refused"
            );
            assert!(
                folder("zed", target, None, "/home/k/proj").is_err(),
                "{target:?} should be refused for zed"
            );
        }
    }

    #[test]
    fn surrounding_whitespace_in_the_address_is_trimmed_not_passed_on() {
        assert_eq!(
            folder("vscode", " k@kgpu\n", None, "/home/k/proj").unwrap(),
            folder("vscode", "k@kgpu", None, "/home/k/proj").unwrap()
        );
    }

    #[test]
    fn unusual_paths_are_refused() {
        for path in [
            "relative/path",
            "",
            "/home/k/a\0b",
            "/home/k/a\nb",
            "/home/k/a\rb",
            "C:/Users/k/proj",
            "/home/k/../etc",
            "/home/k/./proj",
        ] {
            assert!(
                folder("vscode", "k@kgpu", None, path).is_err(),
                "{path:?} should be refused"
            );
        }
    }

    #[test]
    fn line_numbers_start_at_one() {
        assert!(remote(
            "vscode",
            "k@kgpu",
            None,
            "/a",
            OpenKind::File,
            Some(0),
            None
        )
        .is_err());
        assert!(remote(
            "vscode",
            "k@kgpu",
            None,
            "/a",
            OpenKind::File,
            Some(1),
            Some(0)
        )
        .is_err());
    }

    #[test]
    fn editors_without_verified_remote_support_are_refused() {
        for editor in ["vscodium", "windsurf", "sublime-text"] {
            let error = folder(editor, "k@kgpu", None, "/home/k/proj").unwrap_err();
            assert!(error.contains("remote"), "{editor}: {error}");
        }
    }

    #[test]
    fn local_files_open_at_their_line() {
        let cwd = Path::new("/work/proj");
        let args = |editor: &str, file, line, column| {
            local_editor_args(definition(editor).unwrap(), cwd, file, line, column)
        };
        assert_eq!(args("vscode", None, None, None), ["/work/proj"]);
        assert_eq!(
            args("vscode", Some("/work/proj/a.ts"), Some(5), Some(2)),
            ["/work/proj", "--goto=/work/proj/a.ts:5:2"]
        );
        assert_eq!(
            args("windsurf", Some("/work/proj/a.ts"), Some(5), None),
            ["/work/proj", "--goto=/work/proj/a.ts:5"]
        );
        assert_eq!(
            args("zed", Some("/work/proj/a.ts"), Some(5), Some(2)),
            ["/work/proj", "/work/proj/a.ts:5:2"]
        );
        assert_eq!(
            args("sublime-text", Some("/work/proj/a.ts"), Some(5), None),
            ["/work/proj", "/work/proj/a.ts"]
        );
        assert_eq!(
            args("vscode", Some("/work/proj/a.ts"), None, None),
            ["/work/proj", "--goto=/work/proj/a.ts"]
        );
    }
}
