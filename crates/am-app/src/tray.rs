use font8x8::legacy::BASIC_LEGACY;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use am_storage::{notifications_repo, Database};

const TRAY_ID: &str = "main";

pub fn badge_label(count: i64) -> String {
    if count > 99 {
        "99+".to_string()
    } else {
        count.to_string()
    }
}

pub fn count_for_tray(db: &Database) -> i64 {
    notifications_repo::count_inbox_unread(db).unwrap_or(0)
}

fn blend_pixel(base: &mut [u8], idx: usize, r: u8, g: u8, b: u8, a: u8) {
    if a == 0 {
        return;
    }
    let alpha = a as u32;
    let inv = 255 - alpha;
    let mix = |dst: u8, src: u8| -> u8 {
        ((src as u32 * alpha + dst as u32 * inv) / 255) as u8
    };
    base[idx] = mix(base[idx], r);
    base[idx + 1] = mix(base[idx + 1], g);
    base[idx + 2] = mix(base[idx + 2], b);
    let dst_a = base[idx + 3] as u32;
    base[idx + 3] = (alpha + dst_a * inv / 255).min(255) as u8;
}

pub fn render_badge_rgba(base_rgba: &[u8], width: u32, height: u32, count: i64) -> Vec<u8> {
    let mut out = base_rgba.to_vec();
    if count <= 0 {
        return out;
    }

    let w = width as i64;
    let h = height as i64;
    let diameter = (width.min(height) as f64 * 0.6).round() as i64;
    let radius = diameter / 2;
    let cx = w - radius - 1;
    let cy = h - radius - 1;

    let put = |out: &mut Vec<u8>, x: i64, y: i64, r: u8, g: u8, b: u8, a: u8| {
        if x < 0 || y < 0 || x >= w || y >= h {
            return;
        }
        let idx = ((y * w + x) * 4) as usize;
        blend_pixel(out, idx, r, g, b, a);
    };

    let r2 = (radius * radius) as i64;
    for y in (cy - radius)..=(cy + radius) {
        for x in (cx - radius)..=(cx + radius) {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= r2 {
                put(&mut out, x, y, 0xE5, 0x39, 0x35, 0xFF);
            }
        }
    }

    let label = badge_label(count);
    let digits: Vec<char> = label.chars().collect();
    let glyph_count = digits.len() as i64;

    let glyph_box = (diameter as f64 * 0.62) as i64;
    let scale = (glyph_box / 8).max(1);
    let glyph_w = 8 * scale;
    let total_w = glyph_w * glyph_count;
    let glyph_h = glyph_w;

    let start_x = cx - total_w / 2;
    let start_y = cy - glyph_h / 2;

    for (gi, ch) in digits.iter().enumerate() {
        let code = *ch as usize;
        let glyph = if code < 128 {
            BASIC_LEGACY[code]
        } else {
            BASIC_LEGACY['?' as usize]
        };
        let gx0 = start_x + gi as i64 * glyph_w;
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..8 {
                if bits & (1 << col) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            let px = gx0 + (col as i64) * scale + sx;
                            let py = start_y + (row as i64) * scale + sy;
                            put(&mut out, px, py, 0xFF, 0xFF, 0xFF, 0xFF);
                        }
                    }
                }
            }
        }
    }

    out
}

fn build_menu(app: &tauri::AppHandle, count: i64) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "tray_show", "Pokaż AbeonMail", true, None::<&str>)?;
    let unread = MenuItem::with_id(
        app,
        "tray_unread",
        format!("Nieprzeczytane: {count}"),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "tray_quit", "Zakończ", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&show, &sep1, &unread, &sep2, &quit])
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<TrayIcon> {
    let count = count_for_tray(&app.state::<crate::state::AppState>().db);
    let menu = build_menu(app, count)?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => focus_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    update_tray(app, count);
    Ok(tray)
}

pub fn update_tray(app: &tauri::AppHandle, count: i64) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    if let Some(base) = app.default_window_icon().cloned() {
        let width = base.width();
        let height = base.height();
        let rgba = render_badge_rgba(base.rgba(), width, height, count);
        let _ = tray.set_icon(Some(Image::new_owned(rgba, width, height)));
    }

    if let Ok(menu) = build_menu(app, count) {
        let _ = tray.set_menu(Some(menu));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_base(width: u32, height: u32) -> Vec<u8> {
        let mut buf = vec![0u8; (width * height * 4) as usize];
        for px in buf.chunks_exact_mut(4) {
            px[0] = 0x20;
            px[1] = 0x40;
            px[2] = 0x60;
            px[3] = 0xFF;
        }
        buf
    }

    #[test]
    fn zero_count_returns_base_unchanged() {
        let base = solid_base(32, 32);
        let out = render_badge_rgba(&base, 32, 32, 0);
        assert_eq!(out, base);
    }

    #[test]
    fn negative_count_returns_base_unchanged() {
        let base = solid_base(32, 32);
        let out = render_badge_rgba(&base, 32, 32, -3);
        assert_eq!(out, base);
    }

    #[test]
    fn small_count_changes_pixels() {
        let base = solid_base(32, 32);
        let out = render_badge_rgba(&base, 32, 32, 5);
        assert_eq!(out.len(), base.len());
        assert_ne!(out, base);
    }

    #[test]
    fn large_count_changes_pixels() {
        let base = solid_base(32, 32);
        let out = render_badge_rgba(&base, 32, 32, 150);
        assert_eq!(out.len(), base.len());
        assert_ne!(out, base);
    }

    #[test]
    fn label_threshold() {
        assert_eq!(badge_label(5), "5");
        assert_eq!(badge_label(99), "99");
        assert_eq!(badge_label(150), "99+");
        assert_eq!(badge_label(100), "99+");
    }
}
