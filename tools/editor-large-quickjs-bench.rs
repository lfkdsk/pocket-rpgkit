// Included into a scratch copy of PocketJS's desktop host by
// editor-large-quickjs-bench.sh. The editor bundle, input reducer, and UI
// reconciliation execute in the shipping QuickJS guest; Rust only drives
// deterministic input and records monotonic timings around guest and native
// surface work.
#[cfg(test)]
mod editor_large_quickjs_bench {
    use super::*;
    use serde_json::Value;
    use std::time::Instant;

    const UP: u32 = 0x0010;
    const RIGHT: u32 = 0x0020;
    const DOWN: u32 = 0x0040;
    const LEFT: u32 = 0x0080;
    const CIRCLE: u32 = 0x2000;
    const VIEWPORT: (u32, u32) = (480, 272);
    const FRAME_BUDGET_MS: f64 = 1_000.0 / 60.0;

    #[derive(Clone, Copy, Default)]
    struct Sample {
        qjs_ms: f64,
        surface_ms: f64,
    }

    struct Bench {
        rt: Runtime,
        temp: PathBuf,
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }

    impl Bench {
        fn boot(dist: &std::path::Path, label: &str) -> Self {
            let scratch_root = PathBuf::from(
                std::env::var("EDITOR_LARGE_BENCH_SCRATCH")
                    .expect("EDITOR_LARGE_BENCH_SCRATCH"),
            );
            let temp = scratch_root.join(format!(
                "qjs-editor-{}-{}",
                std::process::id(),
                label,
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();

            let args = Args {
                app: "editor".into(),
                js: Some(dist.join("editor.js")),
                pak: Some(dist.join("editor.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-editor-large-bench".into()),
                title: "Large project editor QuickJS bench".into(),
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
            let mut bench = Self {
                rt: Runtime::boot(args).unwrap(),
                temp,
            };
            bench.inject_large_map();
            bench.warm(120);
            bench
        }

        fn inject_large_map(&mut self) {
            let result: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    r#"
                    JSON.stringify((() => {
                      const exported = globalThis.__rpgkitEditorExport();
                      if (!exported?.ok) throw new Error("editor export hook is unavailable");
                      const project = JSON.parse(exported.text);
                      const map = project.maps[0];
                      const fill = map.ground[0];
                      map.width = 100;
                      map.height = 100;
                      map.ground = Array(10000).fill(fill);
                      map.upper = [];
                      map.events = [];
                      project.start = { map: map.id, x: 0, y: 0, dir: "down" };
                      return globalThis.__rpgkitEditorInject(JSON.stringify(project));
                    })())
                    "#,
                )
                .unwrap()
            });
            let value: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(value["ok"].as_bool(), Some(true), "large fixture was rejected");
            for _ in 0..4 {
                self.frame(0);
            }
            let state = self.state();
            assert_eq!(state["width"].as_u64(), Some(100));
            assert_eq!(state["height"].as_u64(), Some(100));
            assert!(state["paletteSize"].as_u64().unwrap_or(0) > 80);
        }

        fn state(&self) -> Value {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    r#"
                    JSON.stringify((() => {
                      const state = globalThis.__rpgkitEditorState();
                      const map = state.editor.project.maps[0];
                      return {
                        width: map.width,
                        height: map.height,
                        camera: state.cam,
                        cursor: state.cursor,
                        paletteSize: state.paletteSize,
                        paletteScroll: state.palScroll,
                        dirty: state.editor.dirty,
                        first: map.ground[0],
                        painted: map.ground[100],
                      };
                    })())
                    "#,
                )
                .unwrap()
            });
            serde_json::from_str(&text).unwrap()
        }

        fn frame(&mut self, buttons: u32) -> Sample {
            self.rt.offload.begin_frame();
            let started = Instant::now();
            self.rt.guest.frame(buttons).unwrap();
            let guest_done = Instant::now();
            self.rt.surface.tick();
            let surface_done = Instant::now();
            for (id, error) in self
                .rt
                .supervisor
                .sync(&self.rt.surface)
                .into_iter()
                .chain(self.rt.supervisor.tick())
            {
                panic!("AppInstance {id}: {error}");
            }
            let _ = self.rt.surface.svc_drain();
            self.rt.ticks += 1;
            Sample {
                qjs_ms: (guest_done - started).as_secs_f64() * 1_000.0,
                surface_ms: (surface_done - guest_done).as_secs_f64() * 1_000.0,
            }
        }

        fn warm(&mut self, frames: usize) {
            for _ in 0..frames {
                self.frame(0);
            }
        }

        fn pulse(&mut self, button: u32, samples: &mut Vec<Sample>) {
            samples.push(self.frame(button));
            samples.push(self.frame(0));
        }
    }

    fn percentile(values: &mut [f64], p: f64) -> f64 {
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        values[((values.len() as f64 - 1.0) * p).ceil() as usize]
    }

    fn print_stats(pass: &str, case: &str, samples: &[Sample]) {
        assert!(samples.len() >= 600, "benchmark cases need at least 600 frames");
        let mut qjs: Vec<f64> = samples.iter().map(|sample| sample.qjs_ms).collect();
        let mut surface: Vec<f64> = samples.iter().map(|sample| sample.surface_ms).collect();
        let mut total: Vec<f64> = samples
            .iter()
            .map(|sample| sample.qjs_ms + sample.surface_ms)
            .collect();
        let qjs_mean = qjs.iter().sum::<f64>() / qjs.len() as f64;
        let surface_mean = surface.iter().sum::<f64>() / surface.len() as f64;
        let total_mean = total.iter().sum::<f64>() / total.len() as f64;
        let qjs_p95 = percentile(&mut qjs, 0.95);
        let surface_p95 = percentile(&mut surface, 0.95);
        let total_p95 = percentile(&mut total, 0.95);
        let total_max = *total.last().unwrap();
        println!(
            "EDITOR_LARGE_QJS pass={} case={} n={} qjs_mean={:.4}ms qjs_p95={:.4}ms surface_mean={:.4}ms surface_p95={:.4}ms total_mean={:.4}ms total_p95={:.4}ms total_max={:.4}ms",
            pass,
            case,
            samples.len(),
            qjs_mean,
            qjs_p95,
            surface_mean,
            surface_p95,
            total_mean,
            total_p95,
            total_max,
        );
        assert!(
            total_p95 <= FRAME_BUDGET_MS,
            "{case} total p95 {total_p95:.4}ms exceeds the 60 Hz frame budget",
        );
    }

    fn idle(dist: &std::path::Path, pass: &str) {
        let mut bench = Bench::boot(dist, "idle");
        let samples: Vec<Sample> = (0..600).map(|_| bench.frame(0)).collect();
        print_stats(pass, "canvas-idle-100x100", &samples);
    }

    fn canvas_pan(dist: &std::path::Path, pass: &str) {
        let mut bench = Bench::boot(dist, "pan");
        let mut samples = Vec::with_capacity(792);
        // LEFT at the viewport's left edge intentionally enters the palette,
        // so reset outside the timed region and repeat the full rightward pan.
        for repetition in 0..4 {
            if repetition > 0 {
                bench.inject_large_map();
            }
            for _ in 0..99 {
                bench.pulse(RIGHT, &mut samples);
            }
            assert!(bench.state()["camera"]["x"].as_i64().unwrap_or(0) > 0);
        }
        print_stats(pass, "canvas-pan-100x100", &samples);
    }

    fn palette_scroll(dist: &std::path::Path, pass: &str) {
        let mut bench = Bench::boot(dist, "palette");
        let mut setup = Vec::new();
        bench.pulse(LEFT, &mut setup);
        let mut samples = Vec::with_capacity(640);
        for _ in 0..10 {
            for _ in 0..16 {
                bench.pulse(DOWN, &mut samples);
            }
            assert!(bench.state()["paletteScroll"].as_i64().unwrap_or(0) > 0);
            for _ in 0..16 {
                bench.pulse(UP, &mut samples);
            }
        }
        print_stats(pass, "palette-scroll-large", &samples);
    }

    fn paint(dist: &std::path::Path, pass: &str) {
        let mut bench = Bench::boot(dist, "paint");
        let original = bench.state()["painted"].as_str().unwrap().to_string();
        let mut samples = Vec::with_capacity(800);
        for repetition in 0..4 {
            if repetition > 0 {
                bench.inject_large_map();
            }
            let mut setup = Vec::new();
            bench.pulse(LEFT, &mut setup);
            bench.pulse(DOWN, &mut setup);
            bench.pulse(CIRCLE, &mut setup);
            bench.pulse(RIGHT, &mut setup);
            samples.push(bench.frame(CIRCLE));
            for _ in 0..99 {
                samples.push(bench.frame(CIRCLE | RIGHT));
                samples.push(bench.frame(CIRCLE));
            }
            samples.push(bench.frame(0));
        }
        let state = bench.state();
        assert_eq!(state["dirty"].as_bool(), Some(true));
        assert_ne!(state["painted"].as_str(), Some(original.as_str()));
        print_stats(pass, "paint-stroke-100x100", &samples);
    }

    #[test]
    #[ignore]
    fn large_editor_interactions() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        let pass = std::env::var("EDITOR_LARGE_BENCH_PASS").unwrap_or_else(|_| "single".into());
        idle(&dist, &pass);
        canvas_pan(&dist, &pass);
        palette_scroll(&dist, &pass);
        paint(&dist, &pass);
    }
}
