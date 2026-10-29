use anyhow::{Result, bail};
/// Static stickers are 512px on their longest edge and at most 512 KiB.
pub fn webp(source: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory(source)?;
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 {
        bail!("Empty image")
    };
    let factor = 512.0 / f64::from(w.max(h));
    let resized = img
        .resize_exact(
            (f64::from(w) * factor).round().max(1.0) as u32,
            (f64::from(h) * factor).round().max(1.0) as u32,
            image::imageops::FilterType::Lanczos3,
        )
        .to_rgba8();
    let encoder = webp::Encoder::from_rgba(&resized, resized.width(), resized.height());
    for quality in [90., 80., 70., 60., 50., 40.] {
        let bytes = encoder.encode(quality).to_vec();
        if bytes.len() <= 512 * 1024 {
            return Ok(bytes);
        }
    }
    bail!("Image could not be compressed below Telegram's 512 KiB sticker limit")
}
