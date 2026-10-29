//! Release installation verifies bytes before replacing an executable.
use std::{os::unix::fs::PermissionsExt, process::Command};
#[test]
fn release_installer_checks_checksum_before_installing() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = temp.path().join("release");
    let commands = temp.path().join("commands");
    std::fs::create_dir(&fixture).unwrap();
    std::fs::create_dir(&commands).unwrap();
    let executable = fixture.join("tgfx");
    std::fs::write(&executable, "#!/bin/sh\necho 'tgfx 0.3.0'\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        _ => return,
    };
    let asset = format!("tgfx-{target}.tar.gz");
    assert!(
        Command::new("tar")
            .args(["-czf"])
            .arg(fixture.join(&asset))
            .arg("-C")
            .arg(&fixture)
            .arg("tgfx")
            .status()
            .unwrap()
            .success()
    );
    let hash = if Command::new("sha256sum").arg("--version").output().is_ok() {
        Command::new("sha256sum")
            .arg(fixture.join(&asset))
            .output()
            .unwrap()
    } else {
        Command::new("shasum")
            .args(["-a", "256"])
            .arg(fixture.join(&asset))
            .output()
            .unwrap()
    };
    assert!(hash.status.success());
    let hash = String::from_utf8(hash.stdout)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    let sums = fixture.join("SHA256SUMS");
    std::fs::write(&sums, format!("{hash}  {asset}\n")).unwrap();
    let curl = commands.join("curl");
    std::fs::write(
        &curl,
        r##"#!/bin/sh
set -eu
url=
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
cp "$TGFX_RELEASE_FIXTURE/${url##*/}" "$out"
"##,
    )
    .unwrap();
    std::fs::set_permissions(curl, std::fs::Permissions::from_mode(0o755)).unwrap();
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/install-release.sh");
    let path = std::env::join_paths(std::iter::once(commands.clone()).chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
    ))
    .unwrap();
    let prefix = temp.path().join("installed version");
    let run = |prefix: &std::path::Path| {
        Command::new("sh")
            .arg(&script)
            .args(["--version", "v0.3.0", "--prefix"])
            .arg(prefix)
            .env("TGFX_RELEASE_FIXTURE", &fixture)
            .env("PATH", &path)
            .output()
            .unwrap()
    };
    let output = run(&prefix);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(prefix.join("bin/tgfx").is_file());
    std::fs::write(&sums, format!("{}  {asset}\n", "0".repeat(64))).unwrap();
    let invalid = temp.path().join("invalid");
    let output = run(&invalid);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checksum did not match"));
    assert!(!invalid.join("bin/tgfx").exists());
}
