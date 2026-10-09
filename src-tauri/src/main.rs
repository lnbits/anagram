#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run before GTK or worker threads start. Host GIO modules can shadow the
    // AppImage's modules while requiring incompatible GLib/GnuTLS versions.
    // Leave native packages/dev environments alone: they need their host modules.
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR") {
        if std::path::Path::new(&appdir)
            .join("usr/lib/gio/modules/libgiognutls.so")
            .is_file()
        {
            std::env::remove_var("GIO_EXTRA_MODULES");
        }
    }
    anagram_lib::run();
}
