fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_settings", "save_shortcut", "hide_launcher", "resize_launcher",
            "open_settings", "close_settings", "complete_directory", "begin_search_session",
            "search_files", "get_application_icon", "open_path", "list_plugin_commands",
            "open_plugin", "leave_plugin", "plugin_call", "list_plugins", "reload_plugins", "set_plugin_enabled", "import_plugin", "remove_plugin",
        ]),
    )).expect("构建应用权限失败");
}
