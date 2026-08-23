fn main() {
    println!("cargo:rerun-if-env-changed=PIMPD_RESOURCE_FILE");
    if let Ok(resource_file) = std::env::var("PIMPD_RESOURCE_FILE") {
        println!("cargo:rustc-link-arg={resource_file}");
    }
}
