#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = qingbox_lib::run_helper() { std::process::exit(code); }
    qingbox_lib::run();
}
