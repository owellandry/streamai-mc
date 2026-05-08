// Pipeline de streaming: TTS + PNGtuber + FFmpeg multistream
// Fase 3
#![allow(dead_code)]

use anyhow::Result;
use std::process::Stdio;
use tokio::process::Command;
use tracing::info;

pub struct StreamConfig {
    pub bot_name: String,
    pub avatar_dir: String,   // ruta a los PNGs del bot
    pub rtmp_targets: Vec<RtmpTarget>,
    pub resolution: (u32, u32),
    pub fps: u32,
    pub bitrate: u32,         // kbps
}

pub struct RtmpTarget {
    pub platform: String,
    pub url: String,
    pub key: String,
}

impl RtmpTarget {
    pub fn full_url(&self) -> String {
        format!("{}/{}", self.url.trim_end_matches('/'), self.key)
    }
}

/// Genera audio con Piper TTS y devuelve la ruta al .wav
pub async fn tts(_text: &str, voice: &str, output_path: &str) -> Result<()> {
    let output = Command::new("piper")
        .args([
            "--model", voice,
            "--output_file", output_path,
        ])
        .stdin(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        anyhow::bail!("Piper TTS falló: {}", String::from_utf8_lossy(&output.stderr));
    }

    Ok(())
}

/// Construye y lanza el proceso FFmpeg para multistream con PNGtuber overlay
pub async fn start_stream(config: &StreamConfig, mc_source: &str) -> Result<tokio::process::Child> {
    let (w, h) = config.resolution;
    let fps = config.fps;
    let bitrate = config.bitrate;

    // Construir string de tee para múltiples destinos RTMP
    let tee_targets: Vec<String> = config
        .rtmp_targets
        .iter()
        .map(|t| format!("[f=flv]{}", t.full_url()))
        .collect();
    let tee_string = tee_targets.join("|");

    info!("🎬 Iniciando stream para {} → {} plataformas", config.bot_name, config.rtmp_targets.len());

    // FFmpeg: video MC + PNGtuber overlay en esquina inferior derecha
    let child = Command::new("ffmpeg")
        .args([
            "-re",
            "-i", mc_source,                         // fuente MC (video en loop o screen capture)
            "-i", &format!("{}/idle.png", config.avatar_dir), // PNG del avatar
            "-filter_complex",
            &format!(
                "[0:v]scale={w}:{h}[bg];\
                 [1:v]scale=320:-1[avatar];\
                 [bg][avatar]overlay=W-w-20:H-h-20[v]"
            ),
            "-map", "[v]",
            "-map", "0:a?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-b:v", &format!("{bitrate}k"),
            "-r", &fps.to_string(),
            "-c:a", "aac",
            "-b:a", "128k",
            "-f", "tee",
            &tee_string,
        ])
        .spawn()?;

    Ok(child)
}
