// Build script: stage bundled plugins into the resource directory.
// Tauri v2's bundle.resources doesn't auto-copy directories, so we do it
// here and let the bundler pick up the individual files.
use std::fs;
use std::path::Path;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let src = Path::new(&manifest_dir).join("..").join("..").join("plugins");
    let dst = Path::new(&manifest_dir).join("resources").join("plugins");
    if src.is_dir() {
        let _ = fs::create_dir_all(&dst);
        copy_dir(&src, &dst);
        println!("cargo:rerun-if-changed={}", src.display());
    }
    tauri_build::build();
}

fn copy_dir(src: &Path, dst: &Path) {
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if src_path.is_dir() {
                let _ = fs::create_dir_all(&dst_path);
                copy_dir(&src_path, &dst_path);
            } else if src_path.is_file() {
                let _ = fs::copy(&src_path, &dst_path);
            }
        }
    }
}
