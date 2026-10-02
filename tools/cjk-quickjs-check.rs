// Included into a scratch copy of PocketJS's desktop host by
// cjk-quickjs-check.sh. Boots the Chinese text fixture in the real QuickJS
// guest, plays its dialog the way tests/cjk-text-sim.test.ts does, and writes
// the kinsoku, reflow, long-message pages, choices and shop frames as raw
// RGBA for comparison with the wasm goldens.
#[cfg(test)]
mod cjk_quickjs_check {
    use super::*;

    const CIRCLE: u32 = 0x2000;
    const VIEWPORT: (u32, u32) = (480, 272);

    fn frame(rt: &mut Runtime, buttons: u32) {
        rt.offload.begin_frame();
        rt.guest.frame(buttons).unwrap();
        rt.surface.tick();
        for (id, error) in rt.supervisor.sync(&rt.surface).into_iter().chain(rt.supervisor.tick()) {
            panic!("AppInstance {id}: {error}");
        }
        let _ = rt.surface.svc_drain();
        rt.ticks += 1;
    }

    /// "kind:complete" of the open modal, from the guest's session probe.
    fn modal(rt: &Runtime) -> String {
        rt.guest.with(|ctx| {
            ctx.eval::<String, _>(
                r#"(m => m ? m.kind + ':' + (m.kind !== 'text' || m.complete) : 'none')(globalThis.__rpgSessionState.interp.modal)"#,
            )
            .unwrap()
        })
    }

    fn settle(rt: &mut Runtime) {
        for _ in 0..600 {
            if modal(rt).ends_with(":true") {
                break;
            }
            frame(rt, 0);
        }
        frame(rt, 0);
        frame(rt, 0);
    }

    fn confirm(rt: &mut Runtime) {
        frame(rt, CIRCLE);
        frame(rt, 0);
    }

    fn capture(rt: &Runtime, out: &std::path::Path, name: &str) {
        let (w, h) = VIEWPORT;
        let mut fb = vec![0u8; (w * h * 4) as usize];
        rt.surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            pocketjs_core::raster::render(&*ui, &words, &mut fb);
        });
        std::fs::write(out.join(format!("{name}.rgba")), &fb).unwrap();
        println!("CJK_QJS frame={name} bytes={}", fb.len());
    }

    #[test]
    #[ignore]
    fn cjk_frames() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        let out = PathBuf::from(std::env::var("CJK_QJS_OUT").expect("CJK_QJS_OUT"));
        std::fs::create_dir_all(&out).unwrap();
        let args = Args {
            app: "cjk-text".into(),
            js: Some(dist.join("cjk-text.js")),
            pak: Some(dist.join("cjk-text.pak")),
            file: None,
            data_root: Some(out.join("data")),
            app_id: Some("dev.lfkdsk.pocket-rpgkit-cjk-quickjs-check".into()),
            title: "CJK QuickJS check".into(),
            viewport: VIEWPORT,
            fixed: false,
            native_text: false,
            editor: false,
            companions: Vec::new(),
            system: None,
            svc_connect: None,
            density: 1,
            script: Vec::new(),
            quit_after_ticks: None,
            storm: None,
            announce_ready: false,
            trace_frames: false,
        };
        let mut rt = Runtime::boot(args).unwrap();
        for page in 0..5 {
            settle(&mut rt);
            if page == 1 {
                capture(&rt, &out, "kinsoku");
            }
            if page == 3 {
                capture(&rt, &out, "reflow");
            }
            confirm(&mut rt);
        }
        // The long message: two pages, one confirm each.
        for page in 1..=2 {
            settle(&mut rt);
            capture(&rt, &out, &format!("long-{page}"));
            confirm(&mut rt);
        }
        settle(&mut rt);
        assert!(modal(&rt).starts_with("choices"), "expected the choices box, got {}", modal(&rt));
        capture(&rt, &out, "choices");
        // First option, its reply, then the shop.
        confirm(&mut rt);
        settle(&mut rt);
        confirm(&mut rt);
        frame(&mut rt, 0);
        frame(&mut rt, 0);
        assert!(modal(&rt).starts_with("shop"), "expected the shop box, got {}", modal(&rt));
        capture(&rt, &out, "shop");
    }
}
