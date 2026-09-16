//! Demo: route a Fluid function request between two iroh nodes, peer-to-peer.
//!
//! Node B hosts a "function" and serves the tunnel protocol over iroh.
//! Node A dials B *by node id* and sends a request through a TunnelClient.
//! Proves the whole serving stack works over a P2P QUIC connection.

use std::time::Duration;

use anyhow::Result;
use fluid_tunnel::TunnelClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Minimal HTTP echo server (the "function").
async fn spawn_function() -> Result<String> {
    let l = TcpListener::bind("127.0.0.1:0").await?;
    let addr = l.local_addr()?.to_string();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = match l.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let mut acc = Vec::new();
                loop {
                    match s.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => acc.extend_from_slice(&buf[..n]),
                    }
                    if acc.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let path = String::from_utf8_lossy(&acc)
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                let body = format!("{{\"served_over\":\"iroh-p2p\",\"path\":\"{path}\"}}");
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    Ok(addr)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber_init();
    let classical_peer = std::env::args().any(|arg| arg == "--classical-peer");
    let mldsa_witness = std::env::args().any(|arg| arg == "--mldsa-witness");
    let key_root = std::env::temp_dir().join(format!("hive-pqc-demo-{}", std::process::id()));

    // ---- Node B (the instance host) ----
    let function = spawn_function().await?;
    // Create a genuinely classical-only TLS peer to demonstrate the precise
    // mixed-fleet fallback. This affects its offered KEX groups before bind;
    // the printed result still comes solely from the completed handshake.
    if classical_peer {
        std::env::set_var("HIVE_PQC_WITNESS_CLASSICAL_ONLY", "1");
    }
    let ep_b = if mldsa_witness {
        hive_p2p::bind_full(Some(key_root.join("b-iroh.key")), &[], &[], true).await?
    } else {
        hive_p2p::bind().await?
    };
    if classical_peer {
        std::env::remove_var("HIVE_PQC_WITNESS_CLASSICAL_ONLY");
    }
    let node_b_id = ep_b.id();
    let addr_b = ep_b.addr();
    let b_enrollment = mldsa_witness.then(|| {
        hive_p2p::pqc_enrollment(ep_b.secret_key())
            .expect("persistent endpoint initialized ML-DSA-44")
    });
    println!("node B id: {node_b_id}");
    let max_conc = 100;
    let gossip = mldsa_witness.then(|| {
        std::sync::Arc::new(|_: u8, _: String, _: Vec<u8>, signer: Option<String>| {
            Box::pin(async move {
                format!(
                    "verified dual-signed gossip from {}",
                    signer.unwrap_or_default()
                )
                .into_bytes()
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = Vec<u8>> + Send>>
        }) as hive_p2p::GossipHandler
    });
    tokio::spawn(hive_p2p::serve_tunnels(
        ep_b.clone(),
        function,
        max_conc,
        None,
        gossip,
    ));

    // ---- Node A (the gateway) dials B by endpoint id, over P2P ----
    let ep_a = if mldsa_witness {
        hive_p2p::bind_full(Some(key_root.join("a-iroh.key")), &[], &[], true).await?
    } else {
        hive_p2p::bind().await?
    };
    println!("node A id: {}", ep_a.id());
    println!("dialing node B peer-to-peer over iroh...");
    let stream = hive_p2p::dial(&ep_a, addr_b.clone()).await?;
    let client = TunnelClient::new(stream);

    // Fire a handful of concurrent requests over the single P2P tunnel.
    let client = std::sync::Arc::new(client);
    let mut handles = Vec::new();
    for i in 0..5 {
        let c = client.clone();
        handles.push(tokio::spawn(async move {
            let resp = tokio::time::timeout(
                Duration::from_secs(20),
                c.request(
                    "GET",
                    &format!("/p2p/{i}"),
                    vec![],
                    b"",
                    Duration::from_secs(20),
                ),
            )
            .await
            .expect("timeout")
            .expect("request failed");
            let mut body = Vec::new();
            let mut rx = resp.body;
            while let Some(chunk) = rx.recv().await {
                body.extend_from_slice(&chunk);
            }
            (resp.status, String::from_utf8_lossy(&body).to_string())
        }));
    }
    for (i, h) in handles.into_iter().enumerate() {
        let (status, body) = h.await?;
        println!("  request {i}: status={status} body={body}");
        assert_eq!(status, 200);
        assert!(body.contains("iroh-p2p"));
    }
    if mldsa_witness {
        let enrollment = hive_p2p::pqc_enrollment(ep_a.secret_key())
            .expect("persistent endpoint initialized ML-DSA-44");
        hive_p2p::enroll_pqc_peer(&ep_a.id().to_string(), &enrollment)?;
        hive_p2p::enroll_pqc_peer(
            &node_b_id.to_string(),
            b_enrollment.as_ref().expect("B enrollment"),
        )?;
        // This alters the sender's real wire mode; the response is admitted
        // only after the receiver verifies both signatures against enrollment.
        std::env::set_var("HIVE_GOSSIP_SIGN_V2", "1");
        let response = hive_p2p::PeerPool::new(ep_a.clone())
            .gossip_request(
                &node_b_id.to_string(),
                &serde_json::to_string(&addr_b)?,
                hive_p2p::GOSSIP_POST,
                "/pqc-witness",
                b"dual signature",
            )
            .await?;
        std::env::remove_var("HIVE_GOSSIP_SIGN_V2");
        println!("ML-DSA witness: {}", String::from_utf8_lossy(&response));
        println!(
            "ML-DSA telemetry: {}",
            serde_json::to_string(&hive_p2p::pqc_signing_telemetry())?
        );
        let _ = std::fs::remove_dir_all(&key_root);
    }
    println!(
        "OK: 5 requests routed over an iroh P2P tunnel ({})",
        if classical_peer {
            "classical-only peer witness"
        } else {
            "hybrid peer witness"
        }
    );
    // This is negotiated rustls handshake evidence, not the configured
    // provider or an environment flag.
    println!(
        "negotiated KEX telemetry: {}",
        serde_json::to_string(&hive_p2p::pqc_telemetry())?
    );
    Ok(())
}

fn tracing_subscriber_init() {
    // Best-effort; ignore if already set.
    let _ = std::panic::catch_unwind(|| {});
}
