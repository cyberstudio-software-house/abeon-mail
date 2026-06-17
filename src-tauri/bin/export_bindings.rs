use specta_typescript::Typescript;

fn main() {
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/bindings.ts");
    am_app::build_specta_builder()
        .dangerously_cast_bigints_to_number()
        .export(Typescript::default(), out)
        .expect("failed to export typescript bindings");
}
