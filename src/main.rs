mod bot;
mod ai;
mod stream;
mod dashboard;
mod db;

use anyhow::Result;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok(); // load .env if present

    tracing_subscriber::fmt()
        .with_env_filter("streamai_mc=debug,info")
        .init();

    info!("🎮 StreamAI-MC arrancando...");

    // Inicializar base de datos
    let pool = db::init("sqlite://streamai.db").await?;
    info!("💾 Base de datos lista");

    // Sembrar bots de ejemplo si la DB está vacía
    db::seed_defaults(&pool).await?;

    // Iniciar dashboard web en :8080
    let app_state = dashboard::AppState {
        db: pool,
        mc_server: std::env::var("MC_SERVER").unwrap_or_else(|_| "207.180.205.8:25565".into()),
        running: tokio::sync::Mutex::new(std::collections::HashMap::new()),
    };
    let router = dashboard::router(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    info!("🌐 Dashboard en http://localhost:8080");

    axum::serve(listener, router).await?;

    Ok(())
}

