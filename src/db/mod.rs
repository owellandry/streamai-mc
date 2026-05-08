use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub personality: String,
    pub voice: String,
    pub avatar_dir: String,
    pub mc_username: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct StreamKey {
    pub id: String,
    pub bot_id: String,
    pub platform: String,
    pub rtmp_url: String,
    pub stream_key: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct NewBot {
    pub name: String,
    pub personality: String,
    pub voice: Option<String>,
    pub avatar_dir: Option<String>,
    pub mc_username: String,
}

#[derive(Debug, Deserialize)]
pub struct NewStreamKey {
    pub platform: String,
    pub rtmp_url: String,
    pub stream_key: String,
}

pub async fn init(database_url: &str) -> Result<SqlitePool> {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(database_url.trim_start_matches("sqlite://"))
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bots (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            personality TEXT NOT NULL,
            voice       TEXT NOT NULL DEFAULT 'es_ES-davefx-medium',
            avatar_dir  TEXT NOT NULL DEFAULT 'assets/avatars/default',
            mc_username TEXT NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS stream_keys (
            id         TEXT PRIMARY KEY,
            bot_id     TEXT NOT NULL,
            platform   TEXT NOT NULL,
            rtmp_url   TEXT NOT NULL,
            stream_key TEXT NOT NULL,
            enabled    INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

/// Insertar los 5 personajes por defecto si la DB está vacía
pub async fn seed_defaults(pool: &SqlitePool) -> Result<()> {
    let bots = vec![
        ("bot-nyx",     "Nyx",    "Estratega fría y calculadora. Planifica cada paso antes de actuar. Nunca desperdicia recursos. Siempre prioriza herramientas antes de explorar. Sabe que sin pico no se mina piedra.",  "nyx"),
        ("bot-raze",    "Raze",   "Guerrero valiente pero listo. Ama pelear pero sabe que necesita espada y armadura primero. Busca hierro rápido para equiparse. Protege a los demás bots si los ve.",               "raze"),
        ("bot-bochimc", "Bochimc","Tímida y precavida. Le da miedo la noche así que siempre busca cama primero. Prefiere ir a lo seguro: comida, refugio, y después aventura. Se asusta con los creepers. pero experta en el minecraft, su mision es pasarlo completamente, y no se detiene hasta lograrlo", "bochimc"),
        ("bot-flick",   "Flick",  "Speedrunner que conoce el meta. Sabe la progresión perfecta: madera→piedra→hierro→diamante→nether→end. Optimiza cada segundo pero respeta el orden de crafteo.",                        "flick"),
        ("bot-mika",    "Mika",   "Exploradora curiosa y paciente. Le gusta descubrir biomas y construir bases bonitas. Siempre lleva antorchas y comida extra. Nunca tiene prisa pero siempre progresa.",             "mika"),
    ];

    // Migrate: remove any bots whose ID is not one of our stable slug-based IDs
    let _stable_ids = ["bot-nyx", "bot-raze", "bot-bochimc", "bot-flick", "bot-mika"];
    sqlx::query(
        "DELETE FROM bots WHERE id NOT IN ('bot-nyx','bot-raze','bot-bochimc','bot-flick','bot-mika')"
    ).execute(pool).await?;

    // Upsert: insert if not exists, update name/personality/avatar if already there.
    // Using stable IDs (slug-based) so stream_keys are NEVER lost on restart.
    for (id, name, personality, slug) in &bots {
        sqlx::query(
            "INSERT INTO bots (id, name, personality, avatar_dir, mc_username)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name        = excluded.name,
               personality = excluded.personality,
               avatar_dir  = excluded.avatar_dir",
        )
        .bind(id)
        .bind(name)
        .bind(personality)
        .bind(format!("assets/avatars/{slug}"))
        .bind(slug)
        .execute(pool)
        .await?;
    }

    Ok(())
}
