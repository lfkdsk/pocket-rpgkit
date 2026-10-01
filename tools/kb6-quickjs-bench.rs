// tools/kb6-quickjs-bench.rs — the kit's battle entry/exit frame benchmark.
// Run it with tools/kb6-quickjs-bench.sh, which copies this file `include!`d
// into a scratch copy of vendor/pocketjs/hosts/desktop (path deps rewritten
// to the checkout's own vendor/pocketjs, nothing in the submodule changes).
//
// Boots the real desktop Runtime against dist/r2-ui.{js,pak} with
// globalThis.__r2Battle=true, so the fixture's autorun event opens a toy
// battle on the first frame and a CIRCLE confirm wins it. Times
// Guest::frame (QuickJS) plus UiSurface::tick for the entry and exit frames,
// counts structural UI ops (createNode/destroyNode/insertBefore/removeChild),
// and reads the __rpgkitFrameProfileMark segment timeline (frame-profile.ts):
// reducer, signal batch, and the post-onFrame flush where Show mounts and
// unmounts the world subtree, the dialog box and the battle scene.
//
//   bun run build:example r2-ui   # first: produces dist/r2-ui.{js,pak}
//   tools/kb6-quickjs-bench.sh
#[cfg(test)]
mod kb6_quickjs_bench {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use pocket_mod::qjs::Function;

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

    #[derive(Clone, Default)]
    struct Sample {
        js_ms: f64,
        core_ms: f64,
        ops: Ops,
        marks: Vec<(String, f64)>,
    }

    struct Bench {
        rt: Runtime,
        temp: PathBuf,
        marks: Arc<Mutex<Vec<(String, Instant)>>>,
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }

    impl Bench {
        fn boot(dist: &std::path::Path, viewport: (u32, u32)) -> Self {
            let scratch_root = std::env::var("KB6_BENCH_SCRATCH")
                .unwrap_or_else(|_| std::env::temp_dir().join("pocket-rpgkit-kb6-bench").display().to_string());
            let temp = PathBuf::from(format!(
                "{scratch_root}/qjs-r2-battle-{}-{}x{}",
                std::process::id(), viewport.0, viewport.1,
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();
            let source = std::fs::read_to_string(dist.join("r2-ui.js")).unwrap();
            let js = temp.join("r2-ui.js");
            std::fs::write(
                &js,
                format!("globalThis.__r2Battle=true; globalThis.__r2BattleDelay=2;\n{source}"),
            )
            .unwrap();

            let args = Args {
                app: "r2-ui".into(),
                js: Some(js),
                pak: Some(dist.join("r2-ui.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-kb6-fixture".into()),
                title: "KB6 QuickJS review bench".into(),
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
            let marks: Arc<Mutex<Vec<(String, Instant)>>> = Arc::new(Mutex::new(Vec::new()));
            rt.guest.with(|ctx| {
                // Structural-op counter, same wrapping trick as the KB4 bench.
                ctx.eval::<(), _>(
                    r#"
                    globalThis.__kb6Ops = {createNode:0,destroyNode:0,insertBefore:0,removeChild:0};
                    for (const name of ["createNode","destroyNode","insertBefore","removeChild"]) {
                      const original = globalThis.ui[name];
                      globalThis.ui[name] = function(...args) {
                        globalThis.__kb6Ops[name]++;
                        return original.apply(globalThis.ui, args);
                      };
                    }
                    "#,
                )
                .unwrap();
                // Native segment sink: frame-profile.ts's optional mark hook.
                let sink = marks.clone();
                let mark = Function::new(ctx.clone(), move |stage: String| {
                    sink.lock().unwrap().push((stage, Instant::now()));
                })
                .unwrap();
                ctx.globals().set("__rpgkitFrameProfileMark", mark).unwrap();
            });
            Self { rt, temp, marks }
        }

        fn in_battle(&self) -> bool {
            self.rt
                .guest
                .with(|ctx| ctx.eval::<bool, _>("globalThis.__rpgSessionState?.scene?.kind === 'battle'"))
                .unwrap_or(false)
        }

        fn reset_ops(&self) {
            self.rt
                .guest
                .with(|ctx| ctx.eval::<(), _>("for(const k of Object.keys(globalThis.__kb6Ops))globalThis.__kb6Ops[k]=0"))
                .unwrap();
        }

        fn read_ops(&self) -> Ops {
            let text = self
                .rt
                .guest
                .with(|ctx| ctx.eval::<String, _>("JSON.stringify(globalThis.__kb6Ops)"))
                .unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
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
                self.marks.lock().unwrap().clear();
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
            let marks = if measured {
                let raw = self.marks.lock().unwrap();
                let t0 = raw.first().map(|(_, t)| *t).unwrap_or(a);
                raw.iter().map(|(s, t)| (s.clone(), t.duration_since(t0).as_secs_f64() * 1000.0)).collect()
            } else {
                Vec::new()
            };
            Sample {
                js_ms: (b - a).as_secs_f64() * 1000.0,
                core_ms: (c - b).as_secs_f64() * 1000.0,
                ops: if measured { self.read_ops() } else { Ops::default() },
                marks,
            }
        }

        fn print_transition(viewport: (u32, u32), label: &str, sample: &Sample) {
            let marks = sample
                .marks
                .iter()
                .map(|(stage, ms)| format!("{stage}+{ms:.3}"))
                .collect::<Vec<_>>()
                .join(",");
            println!(
                "KB6_X viewport={}x{} case={} js={:.3}ms core={:.3}ms create={} destroy={} insert={} remove={} marks=[{}]",
                viewport.0, viewport.1, label, sample.js_ms, sample.core_ms,
                sample.ops.create, sample.ops.destroy, sample.ops.insert, sample.ops.remove,
                if marks.is_empty() { "none".to_string() } else { marks },
            );
        }

        fn print_steady(viewport: (u32, u32), label: &str, samples: &[Sample]) {
            let n = samples.len();
            if n == 0 {
                println!("KB6_S viewport={}x{} case={} n=0", viewport.0, viewport.1, label);
                return;
            }
            let mut js: Vec<f64> = samples.iter().map(|s| s.js_ms).collect();
            js.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let sum: f64 = js.iter().sum();
            let ops: Ops = samples.iter().fold(Ops::default(), |mut acc, s| {
                acc.create += s.ops.create;
                acc.destroy += s.ops.destroy;
                acc.insert += s.ops.insert;
                acc.remove += s.ops.remove;
                acc
            });
            println!(
                "KB6_S viewport={}x{} case={} n={} js_mean={:.3}ms js_max={:.3}ms structural_total={}",
                viewport.0, viewport.1, label, n, sum / n as f64, js[n - 1], ops.total(),
            );
        }
    }

    fn run_viewport(dist: &std::path::Path, viewport: (u32, u32)) {
        let mut bench = Bench::boot(dist, viewport);

        // The fixture waits 2 s (120 frames) with the world steady-mounted,
        // then its autorun event opens the battle — the entry frame.
        let mut was_battle = bench.in_battle();
        assert!(!was_battle, "r2-ui booted inside a battle");
        let mut entry: Option<Sample> = None;
        for _ in 0..240 {
            let measured = !bench.in_battle();
            let sample = bench.frame(0, measured);
            let now = bench.in_battle();
            if measured && now {
                entry = Some(sample);
                was_battle = true;
                break;
            }
            was_battle = now;
        }
        let entry = entry.expect("r2-ui delayed battle never opened");
        Bench::print_transition(viewport, "battle-entry", &entry);

        // Steady battle frames (choice idle, no input).
        let mut steady = Vec::new();
        for _ in 0..30 {
            steady.push(bench.frame(0, true));
        }
        Bench::print_steady(viewport, "battle-steady", &steady);

        // CIRCLE confirm: attack (enemyHp 1 -> win pending), then animate out.
        bench.frame(CIRCLE, false);
        let mut exit: Option<Sample> = None;
        for _ in 0..120 {
            let measured = bench.in_battle();
            let sample = bench.frame(0, measured);
            let still = bench.in_battle();
            if was_battle && !still {
                exit = Some(sample);
                was_battle = still;
                break;
            }
            was_battle = still;
        }
        let exit = exit.expect("toy battle never closed after CIRCLE");
        Bench::print_transition(viewport, "battle-exit", &exit);

        // Walking frames after the battle.
        let mut walking = Vec::new();
        for _ in 0..30 {
            walking.push(bench.frame(0, true));
        }
        Bench::print_steady(viewport, "walking-after-battle", &walking);
    }

    #[test]
    #[ignore]
    fn battle_entry_exit_frames() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        run_viewport(&dist, (480, 272));
        run_viewport(&dist, (960, 544));
    }
}
