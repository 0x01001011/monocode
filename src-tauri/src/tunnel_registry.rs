//! Remembers the `ssh -N -L` processes this app starts so a later launch can
//! stop the ones a crash or force quit left behind. `ServerAliveInterval` keeps
//! such an orphan connected, so it never exits by itself.
//!
//! Each tunnel is a file named after its ssh pid that holds the owning app's
//! pid. Only tunnels whose owner is gone are reaped, so a second running
//! instance (MonoCode and a dev build share this directory) is never touched.

use std::path::{Path, PathBuf};

fn dir() -> PathBuf {
    #[cfg(unix)]
    let user = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let user = 0;
    std::env::temp_dir().join(format!("monocode-ssh-tunnels-{user}"))
}

/// Record a freshly started tunnel process as owned by this app.
pub fn record(ssh_pid: u32) {
    let dir = dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let _ = std::fs::write(
        dir.join(ssh_pid.to_string()),
        std::process::id().to_string(),
    );
}

/// Drop the record once the tunnel process has been stopped.
pub fn forget(ssh_pid: u32) {
    let _ = std::fs::remove_file(dir().join(ssh_pid.to_string()));
}

/// Stop tunnels left by an app that is no longer running. Returns how many.
pub fn reap_orphans() -> usize {
    #[cfg(unix)]
    {
        reap_in(&dir(), process_alive, command_line, |pid| unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        })
    }
    #[cfg(not(unix))]
    {
        0
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // EPERM still means the process exists.
    let found = unsafe { libc::kill(pid as i32, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn command_line(pid: u32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// What ssh looks like when this app started it; guards against a recycled pid.
fn is_our_tunnel(command: &str) -> bool {
    command.contains("ssh") && command.contains(" -N") && command.contains(" -L 127.0.0.1:")
}

fn reap_in(
    dir: &Path,
    alive: impl Fn(u32) -> bool,
    command: impl Fn(u32) -> Option<String>,
    terminate: impl Fn(u32),
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut reaped = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(ssh_pid) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let owner = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok());
        if owner.is_some_and(&alive) {
            continue;
        }
        if alive(ssh_pid) && command(ssh_pid).is_some_and(|line| is_our_tunnel(&line)) {
            terminate(ssh_pid);
            reaped += 1;
        }
        let _ = std::fs::remove_file(&path);
    }
    reaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const TUNNEL: &str = "/usr/bin/ssh -T -o ExitOnForwardFailure=yes -N -L 127.0.0.1:50123:127.0.0.1:3774 -- k@kgpu";

    fn registry(entries: &[(&str, &str)]) -> (PathBuf, impl Drop) {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "monocode-tunnel-registry-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, owner) in entries {
            std::fs::write(dir.join(name), owner).unwrap();
        }
        (dir.clone(), Cleanup(dir))
    }

    #[test]
    fn stops_only_tunnels_whose_owner_is_gone() {
        // 100: orphaned tunnel; 200: owned by a live app; 300: pid recycled by another program.
        let (dir, _guard) = registry(&[("100", "1"), ("200", "2"), ("300", "1"), ("junk", "1")]);
        let stopped = RefCell::new(Vec::new());
        let reaped = reap_in(
            &dir,
            |pid| matches!(pid, 2 | 100 | 200 | 300),
            |pid| {
                Some(if pid == 300 {
                    "/bin/vim notes.md".into()
                } else {
                    TUNNEL.to_string()
                })
            },
            |pid| stopped.borrow_mut().push(pid),
        );
        assert_eq!(reaped, 1);
        assert_eq!(*stopped.borrow(), vec![100]);
        // Settled records go; a live owner's record stays; unknown files are left alone.
        assert!(!dir.join("100").exists() && !dir.join("300").exists());
        assert!(dir.join("200").exists() && dir.join("junk").exists());
    }

    #[test]
    fn forgets_records_of_tunnels_that_already_exited() {
        let (dir, _guard) = registry(&[("100", "1")]);
        let reaped = reap_in(&dir, |_| false, |_| None, |_| panic!("nothing to stop"));
        assert_eq!(reaped, 0);
        assert!(!dir.join("100").exists());
    }

    #[test]
    fn recognizes_only_this_apps_tunnels() {
        assert!(is_our_tunnel(TUNNEL));
        assert!(!is_our_tunnel("/usr/bin/ssh k@kgpu"));
        assert!(!is_our_tunnel("/usr/bin/ssh -N -L 8080:localhost:80 host"));
    }
}
