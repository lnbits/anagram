{ pkgs ? import <nixpkgs> {} }:
let
  gst = with pkgs.gst_all_1; [ gstreamer.out gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav ];
in pkgs.mkShell {
  inputsFrom = [ (import ../../shell.nix { inherit pkgs; }) ];
  packages = (with pkgs; [ xdotool xorg.xorgserver pulseaudio ]) ++ gst;
  shellHook = ''
    export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.libpulseaudio ]}:$LD_LIBRARY_PATH"
    export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.lib.makeSearchPath "lib/gstreamer-1.0" gst}"
  '';
}
