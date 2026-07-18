//! lofi-node extension module — NOT upstream code (everything else in src/ is
//! vendored from n0-computer/iroh-ffi iroh-js; see UPSTREAM.md).
//!
//! Buffer-based length-prefixed framing over QUIC streams. Upstream stream I/O
//! moves bytes as `Vec<u8>` ⇄ JS `Array<number>` (measured 7.1 MiB/s loopback
//! round-trip at gate 0) and needs two awaited hops per length-prefixed
//! message. These free functions use napi `Buffer` (zero-copy at the boundary)
//! and one await per frame: u32-BE length prefix + payload.
//!
//! Deletes if upstream grows Buffer-based stream I/O.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::endpoint::{RecvStream, SendStream};

/// Hard frame cap: sized for Jazz sync payloads, not inherited from anywhere.
pub const MAX_FRAME: u32 = 16 * 1024 * 1024;

/// Returns the frame cap so the TS side never hardcodes it.
#[napi]
pub fn max_frame() -> u32 {
    MAX_FRAME
}

/// Write one framed message: u32-BE length prefix, then the payload.
#[napi]
pub async fn write_frame(stream: &SendStream, data: Buffer) -> Result<()> {
    let bytes: &[u8] = &data;
    if bytes.len() > MAX_FRAME as usize {
        return Err(anyhow::anyhow!("frame of {} bytes exceeds MAX_FRAME ({MAX_FRAME})", bytes.len()).into());
    }
    let mut s = stream.0.lock().await;
    s.write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    s.write_all(bytes).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(())
}

/// Read one framed message. `None` when the stream ends (finish/reset/close)
/// at a frame boundary — the TS side's end-of-stream contract. A stream that
/// dies MID-frame is an error, not `None`.
#[napi]
pub async fn read_frame(stream: &RecvStream, max: Option<u32>) -> Result<Option<Buffer>> {
    let max = max.unwrap_or(MAX_FRAME).min(MAX_FRAME);
    let mut r = stream.0.lock().await;
    let mut len_buf = [0u8; 4];
    if r.read_exact(&mut len_buf).await.is_err() {
        // Ended before a new frame started: clean end-of-stream.
        return Ok(None);
    }
    let len = u32::from_be_bytes(len_buf);
    if len > max {
        return Err(anyhow::anyhow!("incoming frame of {len} bytes exceeds cap ({max})").into());
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)
        .await
        .map_err(|e| anyhow::anyhow!("stream ended mid-frame: {e:?}"))?;
    Ok(Some(buf.into()))
}
