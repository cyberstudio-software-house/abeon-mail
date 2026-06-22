use std::path::{Path, PathBuf};

const BAKED_VARS: [&str; 3] = [
    "ABEONMAIL_GOOGLE_CLIENT_ID",
    "ABEONMAIL_GOOGLE_CLIENT_SECRET",
    "ABEONMAIL_MICROSOFT_CLIENT_ID",
];

fn main() {
    if let Some(env_path) = find_env_file() {
        load_env_file(&env_path);
        println!("cargo:rerun-if-changed={}", env_path.display());
    }

    for key in BAKED_VARS {
        println!("cargo:rerun-if-env-changed={key}");
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }
}

fn find_env_file() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..6 {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn load_env_file(path: &Path) {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !BAKED_VARS.contains(&key) {
            continue;
        }
        if std::env::var_os(key).is_some() {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        std::env::set_var(key, value);
    }
}
