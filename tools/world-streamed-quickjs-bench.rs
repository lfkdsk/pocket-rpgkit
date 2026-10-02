// Real-QuickJS performance and residency gate for the connected-world fixture.
// `tools/world-streamed-quickjs-bench.sh` includes this module in a scratch
// copy of the desktop host, so the repository and PocketJS submodule remain
// untouched while the benchmark uses the same Runtime as the shipped host.
#[cfg(test)]
mod world_streamed_quickjs_bench {
    use super::*;
    use std::time::Instant;

    const FRAME_LIMIT_MS: f64 = 50.0;
    const STRUCTURAL: [&str; 4] = ["createNode", "destroyNode", "insertBefore", "removeChild"];

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    struct Ops {
        create: u64,
        destroy: u64,
        insert: u64,
        remove: u64,
    }

    impl Ops {
        fn total(self) -> u64 {
            self.create + self.destroy + self.insert + self.remove
        }
    }

    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct BandStats {
        resident: u64,
        textures: u64,
        texture_bytes: u64,
        pooled: u64,
        created: u64,
        uploads: u64,
        frees: u64,
        pending: u64,
        visible_maps: Vec<String>,
    }

    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct AnimStats {
        mounted: u64,
        created: u64,
        pooled: u64,
    }

    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct StreamStats {
        ground: BandStats,
        upper: BandStats,
        below: AnimStats,
        above: AnimStats,
    }

    impl StreamStats {
        fn textures(&self) -> u64 {
            self.ground.textures + self.upper.textures
        }

        fn texture_bytes(&self) -> u64 {
            self.ground.texture_bytes + self.upper.texture_bytes
        }

        fn pool_nodes(&self) -> u64 {
            self.ground.created + self.upper.created + self.below.created + self.above.created
        }

        fn residency_key(&self) -> (u64, u64, u64, u64, u64, u64, u64, u64) {
            (
                self.ground.resident,
                self.upper.resident,
                self.ground.created,
                self.upper.created,
                self.ground.uploads,
                self.upper.uploads,
                self.ground.frees,
                self.upper.frees,
            )
        }
    }

    #[derive(Clone, Debug, Default)]
    struct Sample {
        js_ms: f64,
        core_ms: f64,
        ops: Ops,
        stats: StreamStats,
        core_textures: u64,
        core_nodes: u64,
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

    fn number(value: &Value, key: &str) -> u64 {
        value.get(key).and_then(Value::as_u64).unwrap_or(0)
    }

    fn band(value: &Value, key: &str) -> BandStats {
        let value = value.get(key).unwrap_or(&Value::Null);
        BandStats {
            resident: number(value, "resident"),
            textures: number(value, "textures"),
            texture_bytes: number(value, "textureBytes"),
            pooled: number(value, "pooled"),
            created: number(value, "created"),
            uploads: number(value, "uploads"),
            frees: number(value, "frees"),
            pending: number(value, "pending"),
            visible_maps: value
                .get("visibleMaps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        }
    }

    fn anim(value: &Value, key: &str) -> AnimStats {
        let value = value.get(key).unwrap_or(&Value::Null);
        AnimStats {
            mounted: number(value, "mounted"),
            created: number(value, "created"),
            pooled: number(value, "pooled"),
        }
    }

    fn count_nodes(ui: &pocketjs_core::Ui, id: i32) -> u64 {
        1 + ui
            .node_children(id)
            .iter()
            .map(|child| count_nodes(ui, *child))
            .sum::<u64>()
    }

    impl Bench {
        fn boot(dist: &std::path::Path, viewport: (u32, u32)) -> Self {
            let scratch_root = std::env::var("WORLD_STREAM_BENCH_SCRATCH").unwrap_or_else(|_| {
                std::env::temp_dir()
                    .join("pocket-rpgkit-world-streamed-bench")
                    .display()
                    .to_string()
            });
            let temp = PathBuf::from(format!(
                "{scratch_root}/qjs-world-{}-{}x{}",
                std::process::id(),
                viewport.0,
                viewport.1,
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();
            let source = std::fs::read_to_string(dist.join("world-streamed.js")).unwrap();
            let js = temp.join("world-streamed.js");
            std::fs::write(
                &js,
                format!(
                    "globalThis.__worldStreamedCamera={{x:{},y:{}}};\n{source}",
                    -(viewport.0 as f64) / 2.0,
                    -(viewport.1 as f64) / 2.0,
                ),
            )
            .unwrap();

            let args = Args {
                app: "world-streamed".into(),
                js: Some(js),
                pak: Some(dist.join("world-streamed.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-world-streamed-fixture".into()),
                title: "Connected world QuickJS bench".into(),
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
            let rt = Runtime::boot(args).unwrap();
            rt.guest
                .eval(
                    "world-streamed-bench-ops",
                    r#"
                    globalThis.__worldStreamOps = {createNode:0,destroyNode:0,insertBefore:0,removeChild:0};
                    for (const name of ["createNode","destroyNode","insertBefore","removeChild"]) {
                      const original = globalThis.ui[name];
                      globalThis.ui[name] = function(a,b,c,d,e) {
                        globalThis.__worldStreamOps[name]++;
                        return original(a,b,c,d,e);
                      };
                    }
                    "#,
                )
                .unwrap();
            Self { rt, temp }
        }

        fn set_camera(&self, x: f64, y: f64) {
            self.rt
                .guest
                .eval(
                    "world-streamed-bench-camera",
                    &format!("globalThis.__worldStreamedCamera={{x:{x},y:{y}}}"),
                )
                .unwrap();
        }

        fn reset_ops(&self) {
            self.rt
                .guest
                .eval(
                    "world-streamed-bench-reset",
                    "for(const k of Object.keys(globalThis.__worldStreamOps))globalThis.__worldStreamOps[k]=0",
                )
                .unwrap();
        }

        fn read_ops(&self) -> Ops {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>("JSON.stringify(globalThis.__worldStreamOps)")
                    .unwrap()
            });
            let value: Value = serde_json::from_str(&text).unwrap();
            Ops {
                create: number(&value, STRUCTURAL[0]),
                destroy: number(&value, STRUCTURAL[1]),
                insert: number(&value, STRUCTURAL[2]),
                remove: number(&value, STRUCTURAL[3]),
            }
        }

        fn read_stats(&self) -> StreamStats {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    "JSON.stringify(globalThis.__worldStreamedStats ?? {})",
                )
                .unwrap()
            });
            let value: Value = serde_json::from_str(&text).unwrap();
            StreamStats {
                ground: band(&value, "ground"),
                upper: band(&value, "upper"),
                below: anim(&value, "below"),
                above: anim(&value, "above"),
            }
        }

        fn core_residency(&self) -> (u64, u64) {
            self.rt.surface.with_ui(|ui| {
                let textures = (0..ui.texture_slot_count())
                    .filter(|slot| ui.texture_at(*slot as u32).is_some())
                    .count() as u64;
                (textures, count_nodes(ui, pocketjs_core::spec::ROOT_ID))
            })
        }

        fn frame(&mut self, measured: bool) -> Sample {
            if measured {
                self.reset_ops();
            }
            self.rt.offload.begin_frame();
            let started = Instant::now();
            self.rt.guest.frame(0).unwrap();
            let guest_done = Instant::now();
            self.rt.surface.tick();
            let core_done = Instant::now();
            for (id, error) in self
                .rt
                .supervisor
                .sync(&self.rt.surface)
                .into_iter()
                .chain(self.rt.supervisor.tick())
            {
                eprintln!("AppInstance {id}: {error}");
            }
            let _ = self.rt.surface.svc_drain();
            self.rt.ticks += 1;
            let (core_textures, core_nodes) = self.core_residency();
            Sample {
                js_ms: (guest_done - started).as_secs_f64() * 1000.0,
                core_ms: (core_done - guest_done).as_secs_f64() * 1000.0,
                ops: if measured { self.read_ops() } else { Ops::default() },
                stats: self.read_stats(),
                core_textures,
                core_nodes,
            }
        }

        fn wait_stable(&mut self) -> StreamStats {
            for _ in 0..120 {
                let sample = self.frame(false);
                if sample.stats.ground.resident > 0
                    && sample.stats.upper.resident > 0
                    && sample.stats.ground.pending == 0
                    && sample.stats.upper.pending == 0
                {
                    return sample.stats;
                }
            }
            panic!("connected-world fixture did not reach a fully resident frame");
        }
    }

    fn percentile(sorted: &[f64], p: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * p).ceil() as usize]
    }

    fn min_max(samples: &[Sample], read: impl Fn(&Sample) -> u64) -> (u64, u64) {
        samples
            .iter()
            .map(read)
            .fold((u64::MAX, 0), |(min, max), value| {
                (min.min(value), max.max(value))
            })
    }

    fn assert_samples(
        viewport: (u32, u32),
        label: &str,
        expected_maps: &[&str],
        expected_residency: (u64, u64, u64, u64, u64, u64, u64, u64),
        samples: &[Sample],
    ) {
        assert!(!samples.is_empty());
        for (index, sample) in samples.iter().enumerate() {
            let frame_ms = sample.js_ms + sample.core_ms;
            assert!(
                frame_ms < FRAME_LIMIT_MS,
                "connected-world QuickJS frame exceeded {FRAME_LIMIT_MS}ms: viewport={}x{} case={label} frame={} measured={frame_ms:.3}ms",
                viewport.0,
                viewport.1,
                index + 1,
            );
            assert_eq!(
                sample.ops.total(),
                0,
                "connected-world pool churned: viewport={}x{} case={label} frame={} ops={:?}",
                viewport.0,
                viewport.1,
                index + 1,
                sample.ops,
            );
            assert_eq!(
                sample.stats.residency_key(),
                expected_residency,
                "connected-world residency changed: viewport={}x{} case={label} frame={}",
                viewport.0,
                viewport.1,
                index + 1,
            );
            let maps: Vec<&str> = sample.stats.ground.visible_maps.iter().map(String::as_str).collect();
            assert_eq!(maps, expected_maps);
            assert_eq!(sample.stats.upper.visible_maps, sample.stats.ground.visible_maps);
            assert_eq!(sample.stats.ground.pending, 0);
            assert_eq!(sample.stats.upper.pending, 0);
            assert!(sample.stats.textures() > 0);
            assert!(sample.stats.pool_nodes() > 0);
        }
    }

    fn print_stats(viewport: (u32, u32), label: &str, samples: &[Sample]) {
        let mut js: Vec<f64> = samples.iter().map(|sample| sample.js_ms).collect();
        let mut core: Vec<f64> = samples.iter().map(|sample| sample.core_ms).collect();
        let mut frame: Vec<f64> = samples
            .iter()
            .map(|sample| sample.js_ms + sample.core_ms)
            .collect();
        js.sort_by(|a, b| a.partial_cmp(b).unwrap());
        core.sort_by(|a, b| a.partial_cmp(b).unwrap());
        frame.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = samples.len();
        println!(
            "WORLD_STREAM_QJS viewport={}x{} case={} n={} frame_mean={:.3}ms frame_p95={:.3}ms frame_max={:.3}ms js_mean={:.3}ms js_p95={:.3}ms core_mean={:.3}ms core_max={:.3}ms limit={:.0}ms",
            viewport.0,
            viewport.1,
            label,
            n,
            frame.iter().sum::<f64>() / n as f64,
            percentile(&frame, 0.95),
            frame[n - 1],
            js.iter().sum::<f64>() / n as f64,
            percentile(&js, 0.95),
            core.iter().sum::<f64>() / n as f64,
            core[n - 1],
            FRAME_LIMIT_MS,
        );
        let (stream_textures_min, stream_textures_max) =
            min_max(samples, |sample| sample.stats.textures());
        let (stream_nodes_min, stream_nodes_max) =
            min_max(samples, |sample| sample.stats.pool_nodes());
        let (core_textures_min, core_textures_max) =
            min_max(samples, |sample| sample.core_textures);
        let (core_nodes_min, core_nodes_max) = min_max(samples, |sample| sample.core_nodes);
        let (texture_bytes_min, texture_bytes_max) =
            min_max(samples, |sample| sample.stats.texture_bytes());
        let structural_total: u64 = samples.iter().map(|sample| sample.ops.total()).sum();
        println!(
            "WORLD_STREAM_RESIDENCY viewport={}x{} case={} stream_textures={}..{} texture_bytes={}..{} pool_nodes={}..{} core_textures={}..{} core_nodes={}..{} structural_ops={}",
            viewport.0,
            viewport.1,
            label,
            stream_textures_min,
            stream_textures_max,
            texture_bytes_min,
            texture_bytes_max,
            stream_nodes_min,
            stream_nodes_max,
            core_textures_min,
            core_textures_max,
            core_nodes_min,
            core_nodes_max,
            structural_total,
        );
    }

    fn run_viewport(dist: &std::path::Path, viewport: (u32, u32)) {
        let mut bench = Bench::boot(dist, viewport);

        let corner = (-(viewport.0 as f64) / 2.0, -(viewport.1 as f64) / 2.0);
        bench.set_camera(corner.0, corner.1);
        let corner_stats = bench.wait_stable();
        let corner_samples: Vec<Sample> = (0..120).map(|_| bench.frame(true)).collect();
        assert_samples(
            viewport,
            "four-map-corner",
            &["a-northwest", "b-northeast", "c-southwest", "d-southeast"],
            corner_stats.residency_key(),
            &corner_samples,
        );
        print_stats(viewport, "four-map-corner", &corner_samples);

        let center_x = -(viewport.0 as f64) / 2.0;
        let seam_y = -320.0 - viewport.1 as f64 / 2.0;
        for delta in [-32.0, 32.0, -32.0] {
            bench.set_camera(center_x + delta, seam_y);
            bench.wait_stable();
        }
        let seam_stats = bench.read_stats();
        let mut seam_samples = Vec::with_capacity(65);
        for delta in -32..=32 {
            bench.set_camera(center_x + delta as f64, seam_y);
            seam_samples.push(bench.frame(true));
        }
        assert_samples(
            viewport,
            "one-pixel-seam-sweep",
            &["a-northwest", "b-northeast"],
            seam_stats.residency_key(),
            &seam_samples,
        );
        print_stats(viewport, "one-pixel-seam-sweep", &seam_samples);
    }

    #[test]
    #[ignore]
    fn connected_world_frame_and_pool_stability() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        run_viewport(&dist, (480, 272));
        run_viewport(&dist, (960, 544));
    }
}
