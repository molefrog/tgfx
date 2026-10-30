//! Bounded, optional image previews. Attachment refs always retain the original.
use crate::{
    files,
    telegram::TelegramApi,
    types::{AttachmentRef, InboundMessage},
};
use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{StreamExt, stream};
use image::{ImageFormat, ImageReader};
use serde_json::{Value, json};
use std::{collections::HashMap, io::Cursor, path::Path, time::Duration};

pub const MAX_INCLUDED_IMAGES: usize = 3;
const MAX_PREVIEW_BYTES: usize = 1_500_000;
const MAX_ORIGINAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PREVIEW_EDGE: u32 = 2560;
const DOWNLOAD_CONCURRENCY: usize = 3;

pub struct Preview {
    pub block: Option<Value>,
    pub status: Value,
}
pub type Previews = HashMap<String, Preview>;

pub fn eligible(a: &AttachmentRef) -> bool {
    a.kind == "photo"
        || matches!(a.kind.as_str(), "document" | "sticker")
            && matches!(
                a.mime_type.as_deref(),
                Some("image/jpeg" | "image/png" | "image/webp" | "image/gif")
            )
}

pub async fn prepare(
    api: &TelegramApi,
    root: &Path,
    m: &mut InboundMessage,
    enabled: bool,
) -> Previews {
    let mut previews = HashMap::new();
    let candidates: Vec<_> = m
        .attachments
        .iter()
        .filter(|a| eligible(a))
        .cloned()
        .collect();
    for (index, a) in candidates.iter().enumerate() {
        if !enabled || index >= MAX_INCLUDED_IMAGES {
            previews.insert(a.reference.clone(), Preview {
                block: None,
                status: json!({"included":false,"reason":if enabled {"image_limit"} else {"disabled"}}),
            });
        }
    }
    if !enabled {
        return previews;
    }
    let context = &m.context_ref;
    let mut jobs = stream::iter(candidates.into_iter().take(MAX_INCLUDED_IMAGES).map(
        |a| async move {
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                download_preview(api, root, context, &a),
            )
            .await;
            (a.reference, result)
        },
    ))
    .buffer_unordered(DOWNLOAD_CONCURRENCY);
    while let Some((reference, result)) = jobs.next().await {
        let preview = match result {
            Ok(Ok((path, block))) => {
                if let Some(a) = m.attachments.iter_mut().find(|a| a.reference == reference) {
                    a.local_path = Some(path);
                }
                Preview {
                    block: Some(block),
                    status: json!({"included":true}),
                }
            }
            _ => Preview {
                block: None,
                status: json!({"included":false,"reason":"preview_unavailable","instructions":"Use download_attachment to access the original."}),
            },
        };
        previews.insert(reference, preview);
    }
    previews
}

async fn download_preview(
    api: &TelegramApi,
    root: &Path,
    context: &str,
    a: &AttachmentRef,
) -> Result<(String, Value)> {
    ensure!(
        a.size.is_none_or(|n| n <= MAX_ORIGINAL_BYTES),
        "Image exceeds download limit"
    );
    let (remote, response) = api.download(&a.file_id).await?;
    let filename = format!(
        "{}_{}",
        a.reference,
        files::safe_name(a.name.as_deref().unwrap_or(&remote))
    );
    let path = files::safe_download_path(root, context, &filename)?;
    if !path.exists() {
        files::write_response_limited(response, &path, MAX_ORIGINAL_BYTES).await?;
    }
    let bytes = tokio::fs::read(&path).await?;
    let block = tokio::task::spawn_blocking(move || encode_preview(bytes)).await??;
    Ok((path.to_string_lossy().into_owned(), block))
}

fn encode_preview(bytes: Vec<u8>) -> Result<Value> {
    let format = image::guess_format(&bytes)?;
    ensure!(
        matches!(
            format,
            ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif
        ),
        "Unsupported image format"
    );
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode()?;
    let (data, mime) = if bytes.len() <= MAX_PREVIEW_BYTES
        && decoded.width().max(decoded.height()) <= MAX_PREVIEW_EDGE
    {
        (bytes, format.to_mime_type())
    } else {
        let format = if decoded.color().has_alpha() {
            ImageFormat::Png
        } else {
            ImageFormat::Jpeg
        };
        let mut edge = MAX_PREVIEW_EDGE.min(decoded.width().max(decoded.height()));
        loop {
            let resized = decoded.thumbnail(edge, edge);
            let mut output = Cursor::new(Vec::new());
            resized.write_to(&mut output, format)?;
            let data = output.into_inner();
            if data.len() <= MAX_PREVIEW_BYTES {
                break (data, format.to_mime_type());
            }
            if edge <= 320 {
                bail!("Cannot fit image preview");
            }
            edge = (edge * 3 / 4).max(320);
        }
    };
    Ok(json!({"type":"image","mimeType":mime,"data":STANDARD.encode(data)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_images_are_resized_without_changing_the_original() {
        let image = image::DynamicImage::new_rgb8(3000, 1000);
        let mut original = Cursor::new(Vec::new());
        image.write_to(&mut original, ImageFormat::Png).unwrap();
        let original = original.into_inner();
        let block = encode_preview(original.clone()).unwrap();
        let preview = STANDARD.decode(block["data"].as_str().unwrap()).unwrap();
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!(decoded.width(), MAX_PREVIEW_EDGE);
        assert!(preview.len() <= MAX_PREVIEW_BYTES);
        assert_eq!(image::load_from_memory(&original).unwrap().width(), 3000);
    }
    #[test]
    fn malformed_images_are_not_sent_to_fx() {
        assert!(encode_preview(b"not an image".to_vec()).is_err());
    }
}
