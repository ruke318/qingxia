fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_shortcuts", "save_shortcut_binding", "set_shortcut_recording", "start_screenshot_command", "capture_cancel", "capture_ready", "capture_export", "pin_close", "pin_scale", "pin_copy", "toggle_fullscreen", "hide_launcher", "resize_launcher",
            "open_settings", "close_settings", "complete_directory", "begin_search_session",
            "search_files", "get_application_icon", "open_path", "list_plugin_commands",
            "open_plugin", "leave_plugin", "plugin_call", "list_plugins", "reload_plugins", "set_plugin_enabled", "import_plugin", "remove_plugin",
        ]),
    )).expect("构建应用权限失败");
}
