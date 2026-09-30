// tools/kb4-quickjs-bench.rs — the KB4 battle UI kit's QuickJS frame-time
// and node-churn benchmark. Run it with tools/kb4-quickjs-bench.sh, which
// copies this file `include!`d into a scratch copy of
// vendor/pocketjs/hosts/desktop (path deps rewritten to the checkout's own
// vendor/pocketjs, nothing in the submodule changes).
//
// Boots the real desktop Runtime against dist/kb4-battle.{js,pak}, times only
// Guest::frame (QuickJS) plus UiSurface::tick, and counts structural UI ops
// (createNode/destroyNode/insertBefore/removeChild) during steady command,
// hit (shake + HP tween), and faint animation frames — the same measurement
// bun test's host-level frame-by-frame assertions make from inside the sim
// renderer (tests/kb4-battle-sim.test.ts), but against the actual QuickJS
// engine the desktop host runs, not Bun/JSC. Every case ASSERTS zero
// structural ops across every collected frame (not just prints the count):
// MessageBand's invisible-placeholder guard (src/ui/battle/MessageBand.tsx)
// is the entire point of this kit's steady-state node-count budget, so a
// regression there must fail this test, not just change a printed number.
#[cfg(test)]
mod kb4_quickjs_bench {
    use super::*;
    use std::time::Instant;

    const CIRCLE: u32 = 0x2000;
    const STRUCTURAL: [&str; 4] = ["createNode", "destroyNode", "insertBefore", "removeChild"];

    #[derive(Clone, Copy, Default)]
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

    #[derive(Clone, Copy, Default)]
    struct Sample {
        js_ms: f64,
        core_ms: f64,
        ops: Ops,
    }

    struct BattleState {
        phase: String,
        effect: String,
        now: i64,
        start: i64,
        duration: i64,
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
            let scratch_root = std::env::var("KB4_BENCH_SCRATCH")
                .unwrap_or_else(|_| std::env::temp_dir().join("pocket-rpgkit-kb4-bench").display().to_string());
            let temp = PathBuf::from(format!(
                "{scratch_root}/qjs-battle-{}-{}x{}",
                std::process::id(), viewport.0, viewport.1,
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();
            let source = std::fs::read_to_string(dist.join("kb4-battle.js")).unwrap();
            let js = temp.join("kb4-battle.js");
            std::fs::write(
                &js,
                format!("globalThis.__kb4Setup={{enemyHp:4}};\n{source}"),
            )
            .unwrap();

            let args = Args {
                app: "kb4-battle".into(),
                js: Some(js),
                pak: Some(dist.join("kb4-battle.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-kb4-battle-fixture".into()),
                title: "KB4 QuickJS review bench".into(),
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
            rt.guest.with(|ctx| {
                ctx.eval::<(), _>(
                    r#"
                    globalThis.__battleOps = {createNode:0,destroyNode:0,insertBefore:0,removeChild:0};
                    for (const name of ["createNode","destroyNode","insertBefore","removeChild"]) {
                      const original = globalThis.ui[name];
                      globalThis.ui[name] = function(a,b,c,d,e) {
                        globalThis.__battleOps[name]++;
                        return original(a,b,c,d,e);
                      };
                    }
                    "#,
                )
                .unwrap();
            });
            Self { rt, temp }
        }

        fn state(&self) -> BattleState {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    r#"JSON.stringify((()=>{const s=globalThis.__rpgSessionState?.scene?.state;return s?[s.phase,s.effectKind,s.nowTick,s.beatStart,s.beatDuration]:["","",-1,-1,-1]})())"#,
                )
                .unwrap()
            });
            let v: Value = serde_json::from_str(&text).unwrap();
            BattleState {
                phase: v[0].as_str().unwrap_or("").to_string(),
                effect: v[1].as_str().unwrap_or("").to_string(),
                now: v[2].as_i64().unwrap_or(-1),
                start: v[3].as_i64().unwrap_or(-1),
                duration: v[4].as_i64().unwrap_or(-1),
            }
        }

        fn reset_ops(&self) {
            self.rt.guest.with(|ctx| {
                ctx.eval::<(), _>(
                    r#"for(const k of Object.keys(globalThis.__battleOps))globalThis.__battleOps[k]=0"#,
                )
                .unwrap();
            });
        }

        fn read_ops(&self) -> Ops {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>("JSON.stringify(globalThis.__battleOps)").unwrap()
            });
            let v: Value = serde_json::from_str(&text).unwrap();
            Ops {
                create: v[STRUCTURAL[0]].as_u64().unwrap_or(0),
                destroy: v[STRUCTURAL[1]].as_u64().unwrap_or(0),
                insert: v[STRUCTURAL[2]].as_u64().unwrap_or(0),
                remove: v[STRUCTURAL[3]].as_u64().unwrap_or(0),
            }
        }

        fn frame(&mut self, buttons: u32, measured: bool) -> Sample {
            if measured {
                self.reset_ops();
            }
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
                eprintln!("AppInstance {id}: {error}");
            }
            let _ = self.rt.surface.svc_drain();
            self.rt.ticks += 1;
            Sample {
                js_ms: (b - a).as_secs_f64() * 1000.0,
                core_ms: (c - b).as_secs_f64() * 1000.0,
                ops: if measured { self.read_ops() } else { Ops::default() },
            }
        }

        fn ready(&self) -> bool {
            let s = self.state();
            s.phase == "beat" && s.now - s.start >= s.duration
        }

        fn wait_ready(&mut self) {
            for _ in 0..600 {
                if self.ready() {
                    return;
                }
                self.frame(0, false);
            }
            panic!("battle beat did not become ready");
        }

        fn collect(&mut self, frames: usize) -> Vec<Sample> {
            (0..frames).map(|_| self.frame(0, true)).collect()
        }
    }

    fn percentile(sorted: &[f64], p: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * p).ceil() as usize]
    }

    fn print_stats(viewport: (u32, u32), label: &str, samples: &[Sample]) {
        let mut js: Vec<f64> = samples.iter().map(|s| s.js_ms).collect();
        let mut core: Vec<f64> = samples.iter().map(|s| s.core_ms).collect();
        js.sort_by(|a, b| a.partial_cmp(b).unwrap());
        core.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = samples.len();
        let totals = samples.iter().fold(Ops::default(), |mut out, sample| {
            out.create += sample.ops.create;
            out.destroy += sample.ops.destroy;
            out.insert += sample.ops.insert;
            out.remove += sample.ops.remove;
            out
        });
        let structural_max = samples.iter().map(|s| s.ops.total()).max().unwrap_or(0);
        let churn: Vec<String> = samples
            .iter()
            .enumerate()
            .filter(|(_, sample)| sample.ops.total() != 0)
            .map(|(index, sample)| format!(
                "{}:{}/{}/{}/{}",
                index + 1,
                sample.ops.create,
                sample.ops.destroy,
                sample.ops.insert,
                sample.ops.remove,
            ))
            .collect();
        println!(
            "KB4_QJS viewport={}x{} case={} n={} js_mean={:.3}ms js_p95={:.3}ms js_max={:.3}ms core_mean={:.3}ms core_max={:.3}ms create={} destroy={} insert={} remove={} structural_max_per_frame={}",
            viewport.0,
            viewport.1,
            label,
            n,
            js.iter().sum::<f64>() / n as f64,
            percentile(&js, 0.95),
            js[n - 1],
            core.iter().sum::<f64>() / n as f64,
            core[n - 1],
            totals.create,
            totals.destroy,
            totals.insert,
            totals.remove,
            structural_max,
        );
        let churn_text = if churn.is_empty() { "none".to_string() } else { churn.join(",") };
        println!(
            "KB4_CHURN viewport={}x{} case={} frames={}",
            viewport.0, viewport.1, label, churn_text,
        );
        assert_eq!(
            totals.total(),
            0,
            "KB4 QuickJS bench: viewport={}x{} case={} saw nonzero structural ops \
             (create={} destroy={} insert={} remove={}, per-frame churn: {}) — \
             MessageBand's typewriter/legend must stay on the replaceText path, \
             never create/destroy/insert/remove a node, once its host frame is steady",
            viewport.0, viewport.1, label, totals.create, totals.destroy, totals.insert, totals.remove, churn_text,
        );
    }

    fn run_viewport(dist: &std::path::Path, viewport: (u32, u32)) {
        let mut bench = Bench::boot(dist, viewport);
        bench.wait_ready();
        bench.frame(CIRCLE, false); // intro -> command
        bench.frame(0, false); // release
        assert_eq!(bench.state().phase, "command");
        print_stats(viewport, "command-idle", &bench.collect(120));

        bench.frame(CIRCLE, false); // Fight -> hit beat
        assert_eq!(bench.state().effect, "shake");
        print_stats(viewport, "shake+hp-tween", &bench.collect(40));

        bench.wait_ready();
        bench.frame(CIRCLE, false); // hit -> faint beat
        assert_eq!(bench.state().effect, "faint");
        print_stats(viewport, "faint", &bench.collect(40));
    }

    #[test]
    #[ignore]
    fn battle_frame_and_node_churn() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        run_viewport(&dist, (480, 272));
        run_viewport(&dist, (960, 544));
    }
}
