use std::path::Path;

use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace,
    NSGraphicsContext, NSWorkspace,
};
use objc2_foundation::{
    NSDataBase64EncodingOptions, NSDictionary, NSPoint, NSRect, NSSize, NSString,
};

const ICON_PIXELS: isize = 64;

pub fn load_icon(path: &str, main_thread: MainThreadMarker) -> Result<String, String> {
    let application = Path::new(path);
    if !application.is_absolute()
        || !application
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        || !application.is_dir()
    {
        return Err("只能读取已存在的应用包图标".to_string());
    }

    let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    // 固定位图像素，避免 Retina 比例或应用原始大图标扩大 IPC 数据。
    // 传入空指针，由 AppKit 分配并持有完整的 RGBA 像素缓冲区。
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            main_thread.alloc(),
            std::ptr::null_mut(),
            ICON_PIXELS,
            ICON_PIXELS,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            ICON_PIXELS * 4,
            32,
        )
    }
    .ok_or_else(|| "无法创建应用图标位图".to_string())?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
        .ok_or_else(|| "无法创建应用图标绘图上下文".to_string())?;

    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    image.drawInRect_fromRect_operation_fraction(
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(ICON_PIXELS as f64, ICON_PIXELS as f64),
        ),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)),
        NSCompositingOperation::Copy,
        1.0,
    );
    NSGraphicsContext::restoreGraphicsState_class();

    // 空属性字典使用系统默认 PNG 编码，键值泛型由方法签名约束。
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or_else(|| "无法编码应用图标".to_string())?;
    let encoded = png.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty());
    Ok(format!("data:image/png;base64,{encoded}"))
}
