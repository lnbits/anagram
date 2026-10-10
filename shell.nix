{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [ pkg-config cargo rustc ];
  buildInputs = with pkgs; [ openssl gtk3 webkitgtk_4_1 libsoup_3 librsvg glib dbus ];
  shellHook = ''
    export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (with pkgs; [ openssl gtk3 webkitgtk_4_1 libsoup_3 librsvg glib dbus ])}:$LD_LIBRARY_PATH"
  '';
}
