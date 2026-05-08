// Bot worker — Node.js (mineflayer) se comunica con este módulo via HTTP
// El orquestador Rust lanza y controla workers Node.js por cada bot
#![allow(dead_code)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::process::Command;
use tracing::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    pub id: String,
    pub name: String,
    pub personality: String,
    pub mc_server: String,   // host:port
    pub mc_username: String,
    pub worker_port: u16,    // puerto HTTP del worker Node.js
}

/// Estado del bot reportado por el worker
#[derive(Debug, Deserialize, Serialize)]
pub struct BotState {
    pub health: f32,
    pub food: f32,
    pub position: [f64; 3],
    pub inventory: Vec<String>,
    pub nearby_blocks: Vec<String>,
    pub nearby_entities: Vec<String>,
    pub time_of_day: String,
    pub biome: String,
}

/// Acción a ejecutar — enviada al worker
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BotAction {
    Move { x: f64, z: f64 },
    Mine { block: String },
    Craft { item: String, amount: u32 },
    Attack { target: String },
    Chat { message: String },
    Idle { reason: String },
    Eat { food: String },
}

pub struct BotWorker {
    pub config: BotConfig,
    http: reqwest::Client,
}

impl BotWorker {
    pub fn new(config: BotConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    fn base_url(&self) -> String {
        format!("http://localhost:{}", self.config.worker_port)
    }

    /// Obtener el estado actual del mundo desde el worker
    pub async fn get_state(&self) -> Result<BotState> {
        let state = self.http
            .get(format!("{}/state", self.base_url()))
            .send()
            .await?
            .json::<BotState>()
            .await?;
        Ok(state)
    }

    /// Enviar una acción al worker para ejecutar
    pub async fn execute(&self, action: &BotAction) -> Result<()> {
        self.http
            .post(format!("{}/action", self.base_url()))
            .json(action)
            .send()
            .await?;
        Ok(())
    }

    /// Enviar el comentario del stream (el worker lo pasa a TTS)
    pub async fn say(&self, comment: &str) -> Result<()> {
        let mut body = HashMap::new();
        body.insert("text", comment);
        self.http
            .post(format!("{}/say", self.base_url()))
            .json(&body)
            .send()
            .await?;
        Ok(())
    }
}

/// Lanzar el proceso Node.js del bot worker
pub async fn spawn_worker(config: &BotConfig) -> Result<tokio::process::Child> {
    info!("🚀 Lanzando worker para bot {}", config.name);

    let child = Command::new("node")
        .arg("bot-worker/index.js")
        .env("BOT_ID", &config.id)
        .env("BOT_NAME", &config.mc_username)
        .env("MC_SERVER", &config.mc_server)
        .env("WORKER_PORT", config.worker_port.to_string())
        .spawn()?;

    Ok(child)
}

