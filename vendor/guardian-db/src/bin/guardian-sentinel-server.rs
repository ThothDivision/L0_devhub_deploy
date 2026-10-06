//! The `guardian-sentinel-server` binary.
//!
//! Opens a GuardianDB over a `data-dir` and serves the administration RPC on a
//! loopback socket. This process is the **owner** of the storage; the redb file
//! lock means only it may hold the `data-dir` open — tools like the TUI panel
//! attach over the socket (see `docs/ADMIN_RPC_PLAN.md`).
//!
//! Usage:
//!   cargo run --features sentinel --bin guardian-sentinel-server
//!   cargo run --features sentinel --bin guardian-sentinel-server -- --addr 127.0.0.1:15433 --data-dir ./guardian_data

use std::path::PathBuf;
use std::sync::Arc;

use guardian_db::p2p::network::config::MdnsDiscoveryAuth;
use guardian_db::sentinel::{
    AdminContext, AdminSource, DEFAULT_ADDR, EmbeddedSource, open_owned_with_peering, serve,
};
use zeroize::Zeroizing;

fn known_peers_from_env() -> Result<Vec<iroh::EndpointId>, Box<dyn std::error::Error>> {
    let raw = match std::env::var("GUARDIAN_KNOWN_PEERS") {
        Ok(raw) => raw,
        Err(std::env::VarError::NotPresent) => return Ok(Vec::new()),
        Err(error) => return Err(format!("GUARDIAN_KNOWN_PEERS is invalid: {error}").into()),
    };
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry.parse::<iroh::EndpointId>().map_err(|error| {
                format!("GUARDIAN_KNOWN_PEERS entry '{entry}' is not an endpoint id: {error}")
                    .into()
            })
        })
        .collect()
}

fn mdns_auth_from_env() -> Result<Option<MdnsDiscoveryAuth>, Box<dyn std::error::Error>> {
    let raw = match std::env::var("GUARDIAN_MDNS_KEY_HEX") {
        Ok(raw) => Zeroizing::new(raw),
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(error) => return Err(format!("GUARDIAN_MDNS_KEY_HEX is invalid: {error}").into()),
    };
    let value = raw.trim();
    if value.len() != 64 {
        return Err("GUARDIAN_MDNS_KEY_HEX must contain exactly 64 hexadecimal characters".into());
    }
    let mut key = [0u8; 32];
    hex::decode_to_slice(value, &mut key)
        .map_err(|error| format!("GUARDIAN_MDNS_KEY_HEX is not valid hexadecimal: {error}"))?;
    Ok(Some(MdnsDiscoveryAuth::from_key_material(key)))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "warn,guardian_db=info".to_string()),
        )
        .init();

    let mut addr = DEFAULT_ADDR.to_string();
    let mut data_dir = PathBuf::from("./guardian_data");
    // Token gating action ops. Falls back to the GUARDIAN_ADMIN_TOKEN env var.
    let mut token = std::env::var("GUARDIAN_ADMIN_TOKEN").ok();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--addr" | "-a" => {
                if let Some(v) = args.next() {
                    addr = v;
                }
            }
            "--data-dir" | "-d" => {
                if let Some(v) = args.next() {
                    data_dir = PathBuf::from(v);
                }
            }
            "--token" | "-t" => {
                if let Some(v) = args.next() {
                    token = Some(v);
                }
            }
            "--help" | "-h" => {
                println!(
                    "guardian-sentinel-server — administration RPC for a live GuardianDB\n\n\
                     Usage: guardian-sentinel-server [--addr 127.0.0.1:15433] [--data-dir ./guardian_data] [--token <t>]\n\n\
                     With --token (or GUARDIAN_ADMIN_TOKEN), clients must authenticate before any op.
                     GUARDIAN_MDNS_KEY_HEX enables fleet-authenticated LAN discovery.
                     GUARDIAN_KNOWN_PEERS (comma-separated endpoint ids) admits explicit peers.
                     This process owns the data-dir (redb lock); connect tools over the socket."
                );
                return Ok(());
            }
            other => eprintln!("ignoring unknown argument: {other}"),
        }
    }

    let mdns_auth = mdns_auth_from_env()?;
    let mdns_enabled = mdns_auth.is_some();
    let known_peers = known_peers_from_env()?;
    let known_peer_count = known_peers.len();
    let (db, client) = open_owned_with_peering(&data_dir, mdns_auth, known_peers).await?;

    let ctx = AdminContext::with_data_dir(db.clone(), client, data_dir.clone());
    // Reopen stores created in earlier sessions (G1) so clients see them again.
    ctx.reopen_stores().await;
    let source: Arc<dyn AdminSource> = Arc::new(EmbeddedSource::new(ctx));

    tracing::info!(
        "guardian admin RPC listening on {addr} (data-dir {}, auth {}, mdns {}, explicit peers {known_peer_count})",
        data_dir.display(),
        if token.is_some() { "on" } else { "off" },
        if mdns_enabled { "on" } else { "off" }
    );
    let serve_result = tokio::select! {
        result = serve(&addr, source, token) => result,
        result = tokio::signal::ctrl_c() => result,
    };
    let close_result = db.close().await;
    serve_result?;
    close_result?;
    Ok(())
}
