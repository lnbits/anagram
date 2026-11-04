fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        cc::Build::new()
            .file("mobile/ios/CallAudio.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("anagram_call_audio");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UIKit");
        println!("cargo:rerun-if-changed=mobile/ios/CallAudio.m");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "iroh_call",
            "iroh_call_send",
            "read_private_key",
            "write_private_key",
            "remove_private_key",
            "android_notification_command",
            "set_mobile_call_audio",
        ]),
    ))
    .expect("failed to build Anagram permissions");
}
