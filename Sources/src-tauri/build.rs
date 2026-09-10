fn main() {
    println!("cargo:rerun-if-changed=../public/tanren.ico");
    tauri_build::build()
}
