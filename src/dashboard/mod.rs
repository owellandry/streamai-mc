use axum::{
    Router,
    routing::{get, post, delete},
    Json,
    extract::{State, Path},
    response::Html,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::process::Child;
use uuid::Uuid;

use crate::db::{Bot, NewBot, NewStreamKey, StreamKey};

pub struct AppState {
    pub db: SqlitePool,
    pub mc_server: String,
    /// Procesos de bots corriendo: bot_id → (proceso, puerto_worker)
    pub running: Mutex<HashMap<String, (Child, u16)>>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        panic!("AppState no debe clonarse — usa Arc<AppState>");
    }
}

type S = State<Arc<AppState>>;

pub fn router(state: AppState) -> Router {
    let shared = Arc::new(state);
    Router::new()
        .route("/",                              get(index))
        .route("/api/status",                    get(api_status))
        .route("/api/bots",                      get(list_bots).post(create_bot))
        .route("/api/bots/:id",                  delete(delete_bot))
        .route("/api/bots/:id/test",             post(test_bot))
        .route("/api/bots/:id/state",            get(bot_state))
        .route("/api/bots/:id/start",            post(start_bot))
        .route("/api/bots/:id/stop",             post(stop_bot))
        .route("/api/bots/:id/stream_keys",      get(list_keys).post(create_key))
        .route("/api/stream_keys/:id",           delete(delete_key))
        .fallback(|req: axum::extract::Request| async move {
            let method = req.method().clone();
            let path   = req.uri().path().to_string();
            tracing::warn!("❓ Ruta no encontrada: {} {}", method, path);
            axum::Json(serde_json::json!({ "error": "not found", "path": path, "method": method.as_str() }))
        })
        .with_state(shared)
}

async fn index() -> Html<String> {
    let html = std::fs::read_to_string("static/index.html")
        .unwrap_or_else(|_| "<h1>Error: static/index.html no encontrado</h1>".into());
    Html(html)
}

async fn api_status(State(s): S) -> Json<Value> {
    let running = s.running.lock().await;
    Json(json!({
        "status": "ok",
        "version": "0.1.0",
        "mc_server": s.mc_server,
        "bots_running": running.keys().cloned().collect::<Vec<_>>()
    }))
}

async fn list_bots(State(s): S) -> Json<Value> {
    let bots = sqlx::query_as::<_, Bot>("SELECT * FROM bots ORDER BY name")
        .fetch_all(&s.db)
        .await
        .unwrap_or_default();

    let running = s.running.lock().await;
    let bots_with_status: Vec<Value> = bots.iter().map(|b| {
        let mut v = serde_json::to_value(b).unwrap();
        v["running"] = json!(running.contains_key(&b.id));
        v
    }).collect();

    Json(json!({ "bots": bots_with_status }))
}

async fn create_bot(State(s): S, Json(body): Json<NewBot>) -> Json<Value> {
    let id = Uuid::new_v4().to_string();
    let voice = body.voice.unwrap_or_else(|| "es_ES-davefx-medium".into());
    let avatar_dir = body.avatar_dir.unwrap_or_else(|| format!("assets/avatars/{}", body.name.to_lowercase()));

    match sqlx::query(
        "INSERT INTO bots (id, name, personality, voice, avatar_dir, mc_username) VALUES (?,?,?,?,?,?)"
    )
    .bind(&id).bind(&body.name).bind(&body.personality)
    .bind(&voice).bind(&avatar_dir).bind(&body.mc_username)
    .execute(&s.db).await {
        Ok(_)  => Json(json!({ "ok": true, "id": id })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn delete_bot(State(s): S, Path(id): Path<String>) -> Json<Value> {
    // Parar bot si está corriendo
    let mut running = s.running.lock().await;
    if let Some((mut child, _port)) = running.remove(&id) {
        child.kill().await.ok();
    }
    drop(running);

    sqlx::query("DELETE FROM bots WHERE id = ?")
        .bind(&id).execute(&s.db).await.ok();
    Json(json!({ "ok": true }))
}

async fn test_bot(State(s): S, Path(id): Path<String>) -> Json<Value> {
    let mut running = s.running.lock().await;

    if running.contains_key(&id) {
        return Json(json!({ "ok": false, "error": "Bot ya está corriendo (stop primero)" }));
    }

    let bot = match sqlx::query_as::<_, Bot>("SELECT * FROM bots WHERE id = ?")
        .bind(&id).fetch_optional(&s.db).await {
        Ok(Some(b)) => b,
        _ => return Json(json!({ "ok": false, "error": "Bot no encontrado" })),
    };

    let port = 3001u16 + (running.len() as u16);
    tracing::info!("🧪 Modo TEST bot {} en puerto {}", bot.name, port);

    // Lanzar worker con --hot para hot-reload de código sin matar el proceso
    let child = tokio::process::Command::new("bun")
        .arg("--hot")
        .arg("run")
        .arg("bot-worker/index.ts")
        .env("BOT_ID", &id)
        .env("BOT_NAME", &bot.mc_username)
        .env("MC_SERVER", &s.mc_server)
        .env("WORKER_PORT", port.to_string())
        .env("PERSONALITY", &bot.personality)
        .env("TEST_MODE", "1")
        .env("AI_PROVIDER",     std::env::var("AI_PROVIDER").unwrap_or_default())
        .env("OLLAMA_URL",      std::env::var("OLLAMA_URL").unwrap_or_default())
        .env("OLLAMA_MODEL",    std::env::var("OLLAMA_MODEL").unwrap_or_default())
        .env("OPENROUTER_KEY",  std::env::var("OPENROUTER_KEY").unwrap_or_default())
        .env("OPENROUTER_MODEL",std::env::var("OPENROUTER_MODEL").unwrap_or_default())
        .env("NVIDIA_KEY",      std::env::var("NVIDIA_KEY").unwrap_or_default())
        .env("NVIDIA_MODEL",    std::env::var("NVIDIA_MODEL").unwrap_or_default())
        .spawn();

    match child {
        Ok(c) => {
            running.insert(id, (c, port));
            Json(json!({ "ok": true, "worker_port": port, "test": true }))
        }
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn bot_state(State(s): S, Path(id): Path<String>) -> Json<Value> {
    let running = s.running.lock().await;
    let port = match running.get(&id) {
        Some((_, p)) => *p,
        None => return Json(json!({ "ok": false, "error": "Bot no está corriendo" })),
    };
    drop(running);

    // Llamar al worker para obtener su estado
    let client = reqwest::Client::new();
    match client.get(format!("http://localhost:{port}/state")).send().await {
        Ok(res) => match res.json::<Value>().await {
            Ok(state) => Json(json!({ "ok": true, "state": state })),
            Err(_)    => Json(json!({ "ok": false, "error": "Worker no responde aún" })),
        },
        Err(_) => Json(json!({ "ok": false, "error": "Worker no disponible todavía" })),
    }
}

async fn start_bot(State(s): S, Path(id): Path<String>) -> Json<Value> {
    let mut running = s.running.lock().await;

    if running.contains_key(&id) {
        return Json(json!({ "ok": false, "error": "Bot ya está corriendo" }));
    }

    // Obtener datos del bot
    let bot = match sqlx::query_as::<_, Bot>("SELECT * FROM bots WHERE id = ?")
        .bind(&id).fetch_optional(&s.db).await {
        Ok(Some(b)) => b,
        _ => return Json(json!({ "ok": false, "error": "Bot no encontrado" })),
    };

    // Asignar puerto del worker (3001 + índice)
    let port = 3001u16 + (running.len() as u16);

    tracing::info!("🚀 Iniciando bot {} en puerto {}", bot.name, port);

    // Cargar stream keys del bot (para auto-stream)
    let stream_targets_json = match sqlx::query_as::<_, crate::db::StreamKey>(
        "SELECT * FROM stream_keys WHERE bot_id = ?"
    ).bind(&id).fetch_all(&s.db).await {
        Ok(keys) if !keys.is_empty() => {
            let arr: Vec<serde_json::Value> = keys.iter().map(|k| serde_json::json!({
                "platform": k.platform,
                "rtmp_url": k.rtmp_url,
                "stream_key": k.stream_key,
            })).collect();
            serde_json::to_string(&arr).unwrap_or_default()
        }
        _ => String::new(),
    };
    if !stream_targets_json.is_empty() {
        tracing::info!("🎬 Bot {} tiene {} stream target(s) configurado(s)", bot.name, stream_targets_json.matches("platform").count());
    }

    let child = tokio::process::Command::new("bun")
        .arg("--hot")
        .arg("run")
        .arg("bot-worker/index.ts")
        .env("BOT_ID", &id)
        .env("BOT_NAME", &bot.mc_username)
        .env("MC_SERVER", &s.mc_server)
        .env("WORKER_PORT", port.to_string())
        .env("PERSONALITY", &bot.personality)
        .env("STREAM_TARGETS", &stream_targets_json)
        .env("AI_PROVIDER",     std::env::var("AI_PROVIDER").unwrap_or_default())
        .env("OLLAMA_URL",      std::env::var("OLLAMA_URL").unwrap_or_default())
        .env("OLLAMA_MODEL",    std::env::var("OLLAMA_MODEL").unwrap_or_default())
        .env("OPENROUTER_KEY",  std::env::var("OPENROUTER_KEY").unwrap_or_default())
        .env("OPENROUTER_MODEL",std::env::var("OPENROUTER_MODEL").unwrap_or_default())
        .env("NVIDIA_KEY",      std::env::var("NVIDIA_KEY").unwrap_or_default())
        .env("NVIDIA_MODEL",    std::env::var("NVIDIA_MODEL").unwrap_or_default())
        .spawn();

    match child {
        Ok(c) => {
            running.insert(id, (c, port));
            Json(json!({ "ok": true, "worker_port": port }))
        }
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn stop_bot(State(s): S, Path(id): Path<String>) -> Json<Value> {
    let mut running = s.running.lock().await;
    match running.remove(&id) {
        Some((mut child, _)) => {
            child.kill().await.ok();
            tracing::info!("🛑 Bot {} detenido", id);
            Json(json!({ "ok": true }))
        }
        None => Json(json!({ "ok": false, "error": "Bot no estaba corriendo" })),
    }
}

async fn list_keys(State(s): S, Path(bot_id): Path<String>) -> Json<Value> {
    let keys = sqlx::query_as::<_, StreamKey>(
        "SELECT * FROM stream_keys WHERE bot_id = ?"
    )
    .bind(&bot_id).fetch_all(&s.db).await.unwrap_or_default();
    Json(json!({ "stream_keys": keys }))
}

async fn create_key(
    State(s): S,
    Path(bot_id): Path<String>,
    Json(body): Json<NewStreamKey>,
) -> Json<Value> {
    let id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO stream_keys (id, bot_id, platform, rtmp_url, stream_key) VALUES (?,?,?,?,?)"
    )
    .bind(&id).bind(&bot_id).bind(&body.platform)
    .bind(&body.rtmp_url).bind(&body.stream_key)
    .execute(&s.db).await {
        Ok(_)  => Json(json!({ "ok": true, "id": id })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn delete_key(State(s): S, Path(id): Path<String>) -> Json<Value> {
    sqlx::query("DELETE FROM stream_keys WHERE id = ?")
        .bind(&id).execute(&s.db).await.ok();
    Json(json!({ "ok": true }))
}
