// tools/krm3v-quickjs-bench.rs — QuickJS frame timings for the imported
// RPG Maker visual fixture. The companion shell script includes this module
// in a scratch copy of PocketJS's real desktop host.
#[cfg(test)]
mod krm3v_quickjs_bench {
    use super::*;
    use std::time::Instant;

    const CIRCLE: u32 = 0x2000;

    #[derive(Clone, Copy, Default)]
    struct Sample {
        js_ms: f64,
        core_ms: f64,
    }

    impl Sample {
        fn total_ms(self) -> f64 {
            self.js_ms + self.core_ms
        }
    }

    #[derive(Default)]
    struct Maxima {
        frames: usize,
        js_ms: f64,
        core_ms: f64,
        total_ms: f64,
    }

    impl Maxima {
        fn add(&mut self, sample: Sample) {
            self.frames += 1;
            self.js_ms = self.js_ms.max(sample.js_ms);
            self.core_ms = self.core_ms.max(sample.core_ms);
            self.total_ms = self.total_ms.max(sample.total_ms());
        }
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
        fn boot(dist: &std::path::Path, viewport: (u32, u32)) -> Self {
            let scratch_root = std::env::var("KRM3V_BENCH_SCRATCH").unwrap_or_else(|_| {
                std::env::temp_dir()
                    .join("pocket-rpgkit-krm3v-bench")
                    .display()
                    .to_string()
            });
            let temp = PathBuf::from(format!(
                "{scratch_root}/qjs-rmi-stage-{}-{}x{}",
                std::process::id(),
                viewport.0,
                viewport.1,
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();

            let source = std::fs::read_to_string(dist.join("rmi-play.js")).unwrap();
            let js = temp.join("rmi-play.js");
            std::fs::write(&js, format!("globalThis.__rmiGame='stage';\n{source}")).unwrap();
            let args = Args {
                app: "rmi-play".into(),
                js: Some(js),
                pak: Some(dist.join("rmi-play.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-krm3v-bench".into()),
                title: "KRM3V QuickJS bench".into(),
                viewport,
                fixed: false,
                native_text: false,
                editor: false,
                companions: Vec::new(),
                system: None,
                svc_connect: None,
                density: 2,
                script: Vec::new(),
                quit_after_ticks: None,
                storm: None,
                announce_ready: false,
                trace_frames: false,
            };
            Self {
                rt: Runtime::boot(args).unwrap(),
                temp,
            }
        }

        fn frame(&mut self, buttons: u32) -> Sample {
            self.rt.offload.begin_frame();
            let a = Instant::now();
            self.rt.guest.frame(buttons).unwrap();
            let b = Instant::now();
            self.rt.surface.tick();
            let c = Instant::now();
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
                js_ms: (b - a).as_secs_f64() * 1000.0,
                core_ms: (c - b).as_secs_f64() * 1000.0,
            }
        }

        fn features(&self) -> (bool, bool) {
            let json = self
                .rt
                .guest
                .with(|ctx| {
                    ctx.eval::<String, _>(
                        r#"JSON.stringify((s => [
                          !!s?.interp?.parallax?.image,
                          !!s?.interp?.anims?.some(a =>
                            a.anim === 'anim001' && s.interp.frame - a.start < 16
                          )
                        ])(globalThis.__rpgSessionState))"#,
                    )
                })
                .unwrap();
            let flags: [bool; 2] = serde_json::from_str(&json).unwrap();
            (flags[0], flags[1])
        }
    }

    fn run_viewport(dist: &std::path::Path, viewport: (u32, u32)) {
        let mut bench = Bench::boot(dist, viewport);
        let mut parallax = Maxima::default();
        let mut animation = Maxima::default();
        let mut saw_animation = false;
        let mut after_animation = 0usize;
        let mut ran = 0usize;

        // Alternating confirm edges advance the authored cutscene while waits,
        // routes, parallax scrolling and the animation still run at 60 Hz.
        for frame in 0..4_000usize {
            let sample = bench.frame(if frame % 2 == 0 { CIRCLE } else { 0 });
            let (has_parallax, has_animation) = bench.features();
            if has_parallax {
                parallax.add(sample);
            }
            if has_animation {
                saw_animation = true;
                animation.add(sample);
                after_animation = 0;
            } else if saw_animation {
                after_animation += 1;
            }
            ran = frame + 1;
            if saw_animation && after_animation >= 30 {
                break;
            }
        }

        assert!(parallax.frames > 0, "stage never exposed its parallax");
        assert!(saw_animation, "stage never reached anim001");
        assert!(animation.frames > 0, "anim001 had no measured frame");
        assert!(
            parallax.total_ms < 50.0,
            "parallax sample exceeded 50 ms: {:.3} ms",
            parallax.total_ms,
        );
        assert!(
            animation.total_ms < 50.0,
            "animation sample exceeded 50 ms: {:.3} ms",
            animation.total_ms,
        );
        println!(
            "KRM3V_QJS viewport={}x{} ran={} parallax_frames={} parallax_js_max={:.3}ms parallax_core_max={:.3}ms parallax_total_max={:.3}ms animation_frames={} animation_js_max={:.3}ms animation_core_max={:.3}ms animation_total_max={:.3}ms",
            viewport.0,
            viewport.1,
            ran,
            parallax.frames,
            parallax.js_ms,
            parallax.core_ms,
            parallax.total_ms,
            animation.frames,
            animation.js_ms,
            animation.core_ms,
            animation.total_ms,
        );
    }

    #[test]
    #[ignore]
    fn imported_visual_frames() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        run_viewport(&dist, (480, 272));
        run_viewport(&dist, (960, 544));
    }
}
