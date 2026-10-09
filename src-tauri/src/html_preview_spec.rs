//! Frozen acceptance spec for HTML previews. Do not edit while iterating:
//! the autoresearch metric is the number of these tests that pass.

use std::fs;
use std::sync::mpsc;
use std::time::Duration;

use super::*;

fn site() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("index.html"), "<h1>Home</h1>").unwrap();
    fs::write(dir.path().join("about page.html"), "<h1>About</h1>").unwrap();
    fs::create_dir_all(dir.path().join("assets/img")).unwrap();
    fs::write(dir.path().join("assets/site.css"), "h1{color:red}").unwrap();
    fs::write(dir.path().join("assets/app.js"), "console.log(1)").unwrap();
    fs::write(
        dir.path().join("assets/img/x.png"),
        [0x89, b'P', b'N', b'G'],
    )
    .unwrap();
    dir
}

fn no_artifacts(_: &str) -> Option<String> {
    None
}

fn header<'a>(response: &'a http::Response<Vec<u8>>, name: &str) -> &'a str {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

#[test]
fn html_preview_tokens_are_random_and_unknown_tokens_404() {
    let dir = site();
    let registry = PreviewRegistry::default();
    let a = registry
        .register(PreviewRoot::Dir(dir.path().into()))
        .unwrap();
    let b = registry
        .register(PreviewRoot::Dir(dir.path().into()))
        .unwrap();
    assert_ne!(a, b);
    assert!(a.len() >= 32 && a.chars().all(|c| c.is_ascii_hexdigit()));
    let missing = serve(
        &registry,
        "/0123456789abcdef0123456789abcdef/index.html",
        no_artifacts,
    );
    assert_eq!(missing.status(), 404);
    registry.remove(&a);
    assert_eq!(
        serve(&registry, &format!("/{a}/index.html"), no_artifacts).status(),
        404
    );
    assert_eq!(
        serve(&registry, &format!("/{b}/index.html"), no_artifacts).status(),
        200
    );
}

#[test]
fn html_preview_serves_index_for_root_and_directories() {
    let dir = site();
    fs::write(dir.path().join("assets/index.html"), "assets home").unwrap();
    let registry = PreviewRegistry::default();
    let token = registry
        .register(PreviewRoot::Dir(dir.path().into()))
        .unwrap();
    for path in [format!("/{token}"), format!("/{token}/")] {
        let response = serve(&registry, &path, no_artifacts);
        assert_eq!(response.status(), 200, "{path}");
        assert_eq!(response.body(), b"<h1>Home</h1>");
    }
    let nested = serve(&registry, &format!("/{token}/assets/"), no_artifacts);
    assert_eq!(nested.body(), b"assets home");
}

#[test]
fn html_preview_resolves_relative_assets_with_mime_types() {
    let dir = site();
    let registry = PreviewRegistry::default();
    let token = registry
        .register(PreviewRoot::Dir(dir.path().into()))
        .unwrap();
    let cases = [
        ("about%20page.html", "text/html", &b"<h1>About</h1>"[..]),
        ("assets/site.css", "text/css", &b"h1{color:red}"[..]),
        ("assets/app.js", "javascript", &b"console.log(1)"[..]),
        (
            "assets/img/x.png",
            "image/png",
            &[0x89, b'P', b'N', b'G'][..],
        ),
    ];
    for (rel, mime, body) in cases {
        let response = serve(&registry, &format!("/{token}/{rel}?v=3"), no_artifacts);
        assert_eq!(response.status(), 200, "{rel}");
        assert!(header(&response, "content-type").contains(mime), "{rel}");
        assert_eq!(response.body(), body, "{rel}");
    }
    assert!(header(
        &serve(&registry, &format!("/{token}/index.html"), no_artifacts),
        "content-type"
    )
    .contains("charset=utf-8"));
}

#[test]
fn html_preview_rejects_traversal_and_absolute_paths() {
    let parent = tempfile::tempdir().unwrap();
    fs::write(parent.path().join("secret.txt"), "secret").unwrap();
    let root = parent.path().join("site");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("index.html"), "ok").unwrap();
    let registry = PreviewRegistry::default();
    let token = registry.register(PreviewRoot::Dir(root)).unwrap();
    for rel in [
        "../secret.txt",
        "%2e%2e/secret.txt",
        "%2E%2E%2Fsecret.txt",
        "a/../../secret.txt",
        "..%5Csecret.txt",
        "%2Fetc%2Fpasswd",
        "C:%5Cwindows%5Cwin.ini",
        "index.html%00.png",
    ] {
        let response = serve(&registry, &format!("/{token}/{rel}"), no_artifacts);
        assert_eq!(response.status(), 404, "{rel}");
        assert!(!String::from_utf8_lossy(response.body()).contains("secret"));
    }
}

#[cfg(unix)]
#[test]
fn html_preview_rejects_symlinks_that_escape_the_root() {
    let parent = tempfile::tempdir().unwrap();
    fs::write(parent.path().join("secret.txt"), "secret").unwrap();
    let root = parent.path().join("site");
    fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink(parent.path().join("secret.txt"), root.join("leak.txt")).unwrap();
    fs::write(root.join("inside.txt"), "inside").unwrap();
    std::os::unix::fs::symlink(root.join("inside.txt"), root.join("alias.txt")).unwrap();
    let registry = PreviewRegistry::default();
    let token = registry.register(PreviewRoot::Dir(root)).unwrap();
    assert_eq!(
        serve(&registry, &format!("/{token}/leak.txt"), no_artifacts).status(),
        404
    );
    assert_eq!(
        serve(&registry, &format!("/{token}/alias.txt"), no_artifacts).status(),
        200
    );
}

#[test]
fn html_preview_sends_isolating_headers() {
    let dir = site();
    let registry = PreviewRegistry::default();
    let token = registry
        .register(PreviewRoot::Dir(dir.path().into()))
        .unwrap();
    for path in [
        format!("/{token}/index.html"),
        format!("/{token}/missing.html"),
    ] {
        let response = serve(&registry, &path, no_artifacts);
        let csp = header(&response, "content-security-policy");
        assert!(csp.contains("default-src"), "{path}: {csp}");
        assert!(
            csp.contains("https:"),
            "scripts and CDNs stay allowed: {csp}"
        );
        assert!(csp.contains("object-src 'none'"), "{csp}");
        // `http:` or `*` would match http://ipc.localhost on Windows.
        assert!(
            !csp.split([' ', ';']).any(|t| t == "http:" || t == "*"),
            "{csp}"
        );
        assert!(!csp.contains("ipc:"), "{csp}");
        assert_eq!(header(&response, "x-content-type-options"), "nosniff");
        assert_eq!(header(&response, "cache-control"), "no-store");
        assert_eq!(header(&response, "access-control-allow-origin"), "*");
    }
}

#[test]
fn html_preview_serves_artifacts_from_storage() {
    let registry = PreviewRegistry::default();
    let token = registry
        .register(PreviewRoot::Artifact("artifact-1".into()))
        .unwrap();
    let lookup = |id: &str| (id == "artifact-1").then(|| "<p>chart</p>".to_string());
    for path in [
        format!("/{token}"),
        format!("/{token}/"),
        format!("/{token}/index.html"),
    ] {
        let response = serve(&registry, &path, lookup);
        assert_eq!(response.status(), 200, "{path}");
        assert!(header(&response, "content-type").starts_with("text/html"));
        assert_eq!(response.body(), b"<p>chart</p>");
    }
    assert_eq!(
        serve(&registry, &format!("/{token}/other.css"), lookup).status(),
        404
    );
    let gone = registry
        .register(PreviewRoot::Artifact("deleted".into()))
        .unwrap();
    assert_eq!(serve(&registry, &format!("/{gone}/"), lookup).status(), 404);
}

#[test]
fn html_preview_register_rejects_missing_or_file_roots() {
    let dir = site();
    let registry = PreviewRegistry::default();
    assert!(registry
        .register(PreviewRoot::Dir(dir.path().join("nope")))
        .is_err());
    assert!(registry
        .register(PreviewRoot::Dir(dir.path().join("index.html")))
        .is_err());
}

#[test]
fn html_preview_watcher_reports_changes_for_its_token() {
    let dir = site();
    let (tx, rx) = mpsc::channel::<String>();
    let watcher = PreviewWatcher::new(move |token: &str| {
        let _ = tx.send(token.to_string());
    })
    .unwrap();
    watcher.watch("tok-a", dir.path()).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    fs::write(dir.path().join("assets/site.css"), "h1{color:blue}").unwrap();
    fs::write(dir.path().join("new.html"), "new").unwrap();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("change event");
    assert_eq!(first, "tok-a");
    // Bursts are debounced into a small number of reloads, not one per write.
    std::thread::sleep(Duration::from_millis(800));
    assert!(rx.try_iter().count() <= 2);
    watcher.unwatch("tok-a");
    std::thread::sleep(Duration::from_millis(200));
    fs::write(dir.path().join("index.html"), "changed").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(1200)).is_err());
}

#[test]
fn html_preview_artifact_kind_html_round_trips() {
    use crate::artifacts::{tests_support, ArtifactKind};
    let kind: ArtifactKind = serde_json::from_value(serde_json::json!("html")).unwrap();
    assert_eq!(serde_json::to_value(kind).unwrap(), "html");
    let artifact = tests_support::save_and_read("page", "html", "<p>x</p>").unwrap();
    assert_eq!(serde_json::to_value(artifact.kind).unwrap(), "html");
    assert_eq!(artifact.body, "<p>x</p>");
}

#[test]
fn html_preview_agent_help_documents_html_artifacts() {
    let help = crate::control_cli::app_help();
    assert!(help.contains(r#""kind":"html""#), "{help}");
}
