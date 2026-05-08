#![allow(dead_code)]

use crate::bot::{BotAction, BotState};
use anyhow::Result;
use serde::{Deserialize, Serialize};

const OLLAMA_URL: &str = "http://localhost:11434";
const MODEL: &str = "qwen2.5:1.5b";

#[derive(Debug, Serialize)]
struct OllamaRequest {
    model: String,
    prompt: String,
    stream: bool,
    format: String,
}

#[derive(Debug, Deserialize)]
struct OllamaResponse {
    response: String,
}

/// Pide al LLM que decida la próxima acción dado el estado del mundo
pub async fn decide(
    client: &reqwest::Client,
    personality: &str,
    state: &BotState,
) -> Result<(BotAction, String)> {
    let state_json = serde_json::to_string_pretty(state)?;

    let prompt = format!(
        r#"Eres un jugador de Minecraft con esta personalidad: {personality}

Estado actual del juego:
{state_json}

Tu objetivo es llegar al End y derrotar al Ender Dragon.

Responde SOLO con JSON válido con dos campos:
- "action": objeto con la acción (move/mine/craft/attack/chat/eat/idle) y sus parámetros
- "comment": lo que dirías en el stream (máx 15 palabras, en español, con tu personalidad)

Ejemplo:
{{"action": {{"action": "mine", "block": "oak_log"}}, "comment": "necesito madera para empezar"}}"#
    );

    let req = OllamaRequest {
        model: MODEL.to_string(),
        prompt,
        stream: false,
        format: "json".to_string(),
    };

    let res: OllamaResponse = client
        .post(format!("{OLLAMA_URL}/api/generate"))
        .json(&req)
        .send()
        .await?
        .json()
        .await?;

    #[derive(Deserialize)]
    struct Parsed {
        action: BotAction,
        comment: String,
    }

    let parsed: Parsed = serde_json::from_str(&res.response)?;
    Ok((parsed.action, parsed.comment))
}
