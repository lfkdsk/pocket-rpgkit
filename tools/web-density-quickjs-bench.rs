// Included into a scratch copy of PocketJS's desktop host by
// web-density-bench.sh. This measures the real QuickJS guest and native UI
// surface at matching 1x/2x build and host densities while replaying three
// deterministic r2-ui workloads: walking, cross-map transfer, and battle.
#[cfg(test)]
mod web_density_quickjs_bench {
    use super::*;
    use std::time::Instant;

    const DOWN: u32 = 0x0040;
    const LEFT: u32 = 0x0080;
    const RIGHT: u32 = 0x0020;
    const VIEWPORT: (u32, u32) = (480, 272);

    #[derive(Clone, Copy, Default)]
    struct Sample {
        qjs_ms: f64,
        surface_ms: f64,
    }

    #[derive(Clone)]
    struct State {
        map: String,
        py: i64,
        battle: bool,
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
        fn boot(dist: &std::path::Path, density: u32, battle: bool) -> Self {
            let scratch_root = PathBuf::from(
                std::env::var("WEB_DENSITY_BENCH_SCRATCH").expect("WEB_DENSITY_BENCH_SCRATCH"),
            );
            let temp = scratch_root.join(format!(
                "qjs-{}-{}-{}",
                std::process::id(),
                density,
                if battle { "battle" } else { "world" },
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();
            let source = std::fs::read_to_string(dist.join("r2-ui.js")).unwrap();
            let js = temp.join("r2-ui.js");
            let prefix = if battle {
                "globalThis.__r2Battle=true; globalThis.__r2BattleDelay=1;\n"
            } else {
                ""
            };
            std::fs::write(&js, format!("{prefix}{source}")).unwrap();

            let args = Args {
                app: "r2-ui".into(),
                js: Some(js),
                pak: Some(dist.join("r2-ui.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-web-density-bench".into()),
                title: "Web density QuickJS bench".into(),
                viewport: VIEWPORT,
                fixed: false,
                native_text: false,
                editor: false,
                companions: Vec::new(),
                system: None,
                svc_connect: None,
                density,
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

        fn state(&self) -> State {
            let text = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    r#"JSON.stringify((s => [s.mapId,s.move.py,s.scene?.kind === 'battle'])(globalThis.__rpgSessionState))"#,
                )
                .unwrap()
            });
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            State {
                map: value[0].as_str().unwrap().to_string(),
                py: value[1].as_i64().unwrap(),
                battle: value[2].as_bool().unwrap(),
            }
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
    }

    fn percentile(values: &mut [f64], p: f64) -> f64 {
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        values[((values.len() as f64 - 1.0) * p).ceil() as usize]
    }

    fn print_stats(density: u32, pass: &str, case: &str, samples: &[Sample]) {
        assert!(!samples.is_empty());
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
        println!(
            "WEBTXT_QJS density={} pass={} case={} n={} qjs_mean={:.4}ms qjs_p95={:.4}ms surface_mean={:.4}ms surface_p95={:.4}ms total_mean={:.4}ms total_p95={:.4}ms",
            density,
            pass,
            case,
            samples.len(),
            qjs_mean,
            qjs_p95,
            surface_mean,
            surface_p95,
            total_mean,
            total_p95,
        );
    }

    fn walking(dist: &std::path::Path, density: u32, pass: &str) {
        let mut bench = Bench::boot(dist, density, false);
        bench.warm(90);
        let before = bench.state();
        let samples: Vec<Sample> = (0..180).map(|_| bench.frame(DOWN)).collect();
        let after = bench.state();
        assert_eq!(
            before.map, after.map,
            "walking case unexpectedly transferred"
        );
        assert!(after.py > before.py, "walking case did not move south");
        print_stats(density, pass, "walk", &samples);
    }

    fn transfers(dist: &std::path::Path, density: u32, pass: &str) {
        let mut bench = Bench::boot(dist, density, false);
        bench.warm(90);
        let first_map = bench.state().map;
        let mut expected_first = true;
        let mut samples = Vec::new();
        for _ in 0..16 {
            let before = bench.state().map;
            let button = if before == first_map { RIGHT } else { LEFT };
            let mut changed = false;
            for _ in 0..80 {
                let sample = bench.frame(button);
                let now = bench.state().map;
                if now != before {
                    samples.push(sample);
                    expected_first = !expected_first;
                    assert_eq!(now == first_map, expected_first);
                    changed = true;
                    break;
                }
            }
            assert!(changed, "transfer case did not cross maps");
            bench.frame(0);
        }
        print_stats(density, pass, "map-transfer", &samples);
    }

    fn battle(dist: &std::path::Path, density: u32, pass: &str) {
        let mut bench = Bench::boot(dist, density, true);
        let mut entered = false;
        for _ in 0..180 {
            bench.frame(0);
            if bench.state().battle {
                entered = true;
                break;
            }
        }
        assert!(entered, "battle case never entered battle");
        bench.warm(30);
        let samples: Vec<Sample> = (0..180).map(|_| bench.frame(0)).collect();
        assert!(bench.state().battle, "battle case exited unexpectedly");
        print_stats(density, pass, "battle", &samples);
    }

    #[test]
    #[ignore]
    fn density_workloads() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        let density = std::env::var("WEB_DENSITY")
            .expect("WEB_DENSITY")
            .parse::<u32>()
            .expect("WEB_DENSITY must be an integer");
        assert!((1..=4).contains(&density));
        let pass = std::env::var("WEB_DENSITY_PASS").unwrap_or_else(|_| "single".into());
        walking(&dist, density, &pass);
        transfers(&dist, density, &pass);
        battle(&dist, density, &pass);
    }
}
