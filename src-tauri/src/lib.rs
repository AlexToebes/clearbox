use tauri_plugin_sql::{Migration, MigrationKind};

mod keychain;

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:clearbox.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            keychain::secret_get,
            keychain::secret_set,
            keychain::secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
