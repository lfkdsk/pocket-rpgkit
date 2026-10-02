// Real-QuickJS timing and residency gate for the world-bounded fixture
// (W2 renderer + W3 cache driver together). `tools/world-bounded-quickjs-
// bench.sh` includes this module in a scratch copy of the desktop host, so
// the repository and PocketJS submodule remain untouched while the benchmark
// uses the same Runtime as the shipped host.
//
// The bench boots the fixture, holds RIGHT to walk the player through all
// twelve maps, holds LEFT to walk all the way back (22 crossings), and
// reports:
//   - guest JS time per frame (the guest.frame call only, not the host
//     surface/supervisor work that follows), split into the boot idle
//     frame, the worst frame of each walk, and the worst frame AT a map
//     switch (the map-change frame: the prefetcher has already prepared the
//     imminent target and the fixture's transfers have no fade, so this is
//     a prefetched crossing, not a cold load);
//   - the per-layer residency MAX accumulated over every frame of the
//     traversal (not just the terminal snapshot), covering the session
//     layers (maps/worlds/tables/staged/pending/preparing/runtime/
//     repoCached) and both terrain bands (textures/resident/created/pooled).
#[cfg(test)]
mod world_bounded_quickjs_bench {
    use super::*;
    use std::time::Instant;

    const FRAME_LIMIT_MS: f64 = 100.0;
    const BTN_RIGHT: u32 = 0x0020;
    const BTN_LEFT: u32 = 0x0080;

    #[derive(Clone, Debug, Default)]
    struct Residency {
        maps: u64,
        worlds: u64,
        tables: u64,
        staged: u64,
        pending: u64,
        preparing: u64,
        runtime: u64,
        repo_cached: u64,
        ground_textures: u64,
        ground_resident: u64,
        ground_created: u64,
        ground_pooled: u64,
        upper_textures: u64,
        upper_resident: u64,
        upper_created: u64,
        upper_pooled: u64,
        visible_maps: u64,
    }

    impl Residency {
        /// Keep the per-layer maximum, so a transient peak between map
        /// switches cannot hide behind the terminal snapshot.
        fn accumulate(&mut self, other: &Residency) {
            self.maps = self.maps.max(other.maps);
            self.worlds = self.worlds.max(other.worlds);
            self.tables = self.tables.max(other.tables);
            self.staged = self.staged.max(other.staged);
            self.pending = self.pending.max(other.pending);
            self.preparing = self.preparing.max(other.preparing);
            self.runtime = self.runtime.max(other.runtime);
            self.repo_cached = self.repo_cached.max(other.repo_cached);
            self.ground_textures = self.ground_textures.max(other.ground_textures);
            self.ground_resident = self.ground_resident.max(other.ground_resident);
            self.ground_created = self.ground_created.max(other.ground_created);
            self.ground_pooled = self.ground_pooled.max(other.ground_pooled);
            self.upper_textures = self.upper_textures.max(other.upper_textures);
            self.upper_resident = self.upper_resident.max(other.upper_resident);
            self.upper_created = self.upper_created.max(other.upper_created);
            self.upper_pooled = self.upper_pooled.max(other.upper_pooled);
            self.visible_maps = self.visible_maps.max(other.visible_maps);
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

    fn number(value: &Value, key: &str) -> u64 {
        value.get(key).and_then(Value::as_u64).unwrap_or(0)
    }

    impl Bench {
        fn boot(dist: &std::path::Path) -> Self {
            let scratch_root = std::env::var("WORLD_BOUNDED_BENCH_SCRATCH").unwrap_or_else(|_| {
                std::env::temp_dir()
                    .join("pocket-rpgkit-world-bounded-bench")
                    .display()
                    .to_string()
            });
            let temp = PathBuf::from(format!(
                "{scratch_root}/qjs-world-bounded-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();
            let source = std::fs::read_to_string(dist.join("world-bounded.js")).unwrap();
            let js = temp.join("world-bounded.js");
            std::fs::write(&js, source).unwrap();

            let args = Args {
                app: "world-bounded".into(),
                js: Some(js),
                pak: Some(dist.join("world-bounded.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-world-bounded-fixture".into()),
                title: "World bounded QuickJS bench".into(),
                viewport: (480, 272),
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
            Self { rt, temp }
        }

        fn current_map(&self) -> String {
            self.rt
                .guest
                .with(|ctx| ctx.eval::<String, _>("globalThis.__rpgSessionState.mapId"))
                .unwrap_or_default()
        }

        fn read_residency(&self) -> Residency {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    "JSON.stringify(globalThis.__worldBoundedStats ?? {})",
                )
                .unwrap_or_default()
            });
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let driver = value.get("driver").unwrap_or(&Value::Null);
            let ground = value.get("ground").unwrap_or(&Value::Null);
            let upper = value.get("upper").unwrap_or(&Value::Null);
            Residency {
                maps: number(driver, "maps"),
                worlds: number(driver, "worlds"),
                tables: number(driver, "tables"),
                staged: number(driver, "staged"),
                pending: number(driver, "pending"),
                preparing: number(driver, "preparing"),
                runtime: number(driver, "runtime"),
                repo_cached: number(driver, "repoCached"),
                ground_textures: number(ground, "textures"),
                ground_resident: number(ground, "resident"),
                ground_created: number(ground, "created"),
                ground_pooled: number(ground, "pooled"),
                upper_textures: number(upper, "textures"),
                upper_resident: number(upper, "resident"),
                upper_created: number(upper, "created"),
                upper_pooled: number(upper, "pooled"),
                visible_maps: ground
                    .get("visibleMaps")
                    .and_then(Value::as_array)
                    .map(|a| a.len() as u64)
                    .unwrap_or(0),
            }
        }

        /// One host frame: deliver buttons, run the guest JS frame, then the
        /// core tick. Returns the GUEST JS time in milliseconds (the
        /// guest.frame call only; the surface/supervisor/service work that
        /// follows is host-side and not counted).
        fn frame(&mut self, buttons: u32) -> f64 {
            self.rt.offload.begin_frame();
            let started = Instant::now();
            self.rt.guest.frame(buttons).unwrap();
            let guest_done = Instant::now();
            self.rt.surface.tick();
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
            (guest_done - started).as_secs_f64() * 1000.0
        }

        /// Hold `direction` until the active map id changes (or the frame
        /// budget runs out). Returns the frames taken, the worst guest JS
        /// time in the burst, and the guest JS time of the crossing frame
        /// (a prefetched map change). Every frame's residency is folded into
        /// `max_seen`.
        fn walk_until_map_change(
            &mut self,
            direction: u32,
            from: &str,
            budget: u32,
            max_seen: &mut Residency,
        ) -> (u32, f64, f64) {
            let mut worst = 0.0_f64;
            let mut cross_ms = 0.0_f64;
            for f in 0..budget {
                let ms = self.frame(direction);
                worst = worst.max(ms);
                max_seen.accumulate(&self.read_residency());
                if self.current_map() != from {
                    cross_ms = ms;
                    return (f + 1, worst, cross_ms);
                }
            }
            panic!("walk_until_map_change: never left {from}");
        }
    }

    #[test]
    #[ignore]
    fn world_bounded_crossings_and_residency() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        let mut bench = Bench::boot(&dist);
        let mut max_seen = Residency::default();

        // One idle frame so the driver's first sync publishes stats. This
        // is the boot idle frame, not a map change.
        let boot_idle_ms = bench.frame(0);
        max_seen.accumulate(&bench.read_residency());
        assert!(max_seen.maps >= 1, "driver did not publish stats");

        // Eastbound: walk the whole line. Twelve maps in a line means 11
        // eastbound crossings.
        let mut east_guest_worst = 0.0_f64;
        let mut map_change_guest_worst = 0.0_f64;
        let mut east_frames = 0_u32;
        for i in 0..11 {
            let from = format!("wb-{:02}", i);
            let (frames, worst, cross_ms) =
                bench.walk_until_map_change(BTN_RIGHT, &from, 300, &mut max_seen);
            east_guest_worst = east_guest_worst.max(worst);
            map_change_guest_worst = map_change_guest_worst.max(cross_ms);
            east_frames += frames;
        }
        assert_eq!(bench.current_map(), "wb-11");

        // Westbound: walk all the way back (11 more crossings, 22 total).
        let mut west_guest_worst = 0.0_f64;
        let mut west_frames = 0_u32;
        for i in (1..=11).rev() {
            let from = format!("wb-{:02}", i);
            let (frames, worst, cross_ms) =
                bench.walk_until_map_change(BTN_LEFT, &from, 300, &mut max_seen);
            west_guest_worst = west_guest_worst.max(worst);
            map_change_guest_worst = map_change_guest_worst.max(cross_ms);
            west_frames += frames;
        }
        assert_eq!(bench.current_map(), "wb-00");

        let end = bench.read_residency();
        max_seen.accumulate(&end);

        // Every guest JS frame must stay inside the budget. The map-change
        // frame is measured separately: the fixture's transfers have no
        // fade and the prefetcher has already prepared the imminent target,
        // so it measures a prefetched crossing, not a cold load.
        let overall_guest_worst = boot_idle_ms.max(east_guest_worst).max(west_guest_worst);
        assert!(
            overall_guest_worst < FRAME_LIMIT_MS,
            "world-bounded QuickJS guest frame exceeded {FRAME_LIMIT_MS}ms: measured={overall_guest_worst:.3}ms",
        );
        assert!(
            map_change_guest_worst < FRAME_LIMIT_MS,
            "world-bounded QuickJS map-change frame exceeded {FRAME_LIMIT_MS}ms: measured={map_change_guest_worst:.3}ms",
        );

        // The maxima must come from the traversal, not the end state: on
        // this fixture the visible set is wider mid-walk than at the west
        // end, so a peak strictly above END proves every frame was folded.
        assert!(
            max_seen.ground_textures > end.ground_textures
                || max_seen.visible_maps > end.visible_maps,
            "residency maxima equal the end state: groundTextures {} vs {}, visibleMaps {} vs {}",
            max_seen.ground_textures, end.ground_textures, max_seen.visible_maps, end.visible_maps,
        );

        // Residency is bounded by the working set, not the 22 map visits.
        // Assert on the per-layer MAX accumulated over every frame, so a
        // transient peak between map switches cannot hide.
        assert!(max_seen.maps <= 3, "maps residency grew: {}", max_seen.maps);
        assert!(max_seen.worlds <= 2, "worlds residency grew: {}", max_seen.worlds);
        assert!(max_seen.tables <= 2, "tables residency grew: {}", max_seen.tables);
        assert!(max_seen.staged <= 2, "staged residency grew: {}", max_seen.staged);
        assert!(max_seen.pending <= 2, "pending residency grew: {}", max_seen.pending);
        assert!(max_seen.preparing <= 10, "preparing residency grew: {}", max_seen.preparing);
        assert!(max_seen.runtime <= 1, "runtime residency grew: {}", max_seen.runtime);
        assert!(max_seen.repo_cached <= 4, "repoCached residency grew: {}", max_seen.repo_cached);
        assert!(max_seen.ground_textures <= 12, "ground textures grew: {}", max_seen.ground_textures);
        assert!(max_seen.ground_resident <= 12, "ground resident grew: {}", max_seen.ground_resident);
        assert!(max_seen.ground_created <= 12, "ground node total grew: {}", max_seen.ground_created);
        assert!(max_seen.upper_textures > 0, "upper fixture loaded no textures");
        assert!(max_seen.upper_textures <= 12, "upper textures grew: {}", max_seen.upper_textures);
        assert!(max_seen.upper_resident <= 12, "upper resident grew: {}", max_seen.upper_resident);
        assert!(max_seen.upper_created <= 12, "upper node total grew: {}", max_seen.upper_created);

        println!(
            "WORLD_BOUNDED_QJS boot_idle={:.3}ms east_guest_worst={:.3}ms west_guest_worst={:.3}ms map_change_guest_worst={:.3}ms overall_guest_worst={:.3}ms east_frames={} west_frames={} limit={:.0}ms",
            boot_idle_ms, east_guest_worst, west_guest_worst, map_change_guest_worst,
            overall_guest_worst, east_frames, west_frames, FRAME_LIMIT_MS,
        );
        println!(
            "WORLD_BOUNDED_RESIDENCY_MAX maps={} worlds={} tables={} staged={} pending={} preparing={} runtime={} repoCached={} groundTextures={} groundResident={} groundCreated={} groundPooled={} upperTextures={} upperResident={} upperCreated={} upperPooled={} visibleMaps={}",
            max_seen.maps, max_seen.worlds, max_seen.tables, max_seen.staged,
            max_seen.pending, max_seen.preparing, max_seen.runtime, max_seen.repo_cached,
            max_seen.ground_textures, max_seen.ground_resident, max_seen.ground_created,
            max_seen.ground_pooled, max_seen.upper_textures, max_seen.upper_resident,
            max_seen.upper_created, max_seen.upper_pooled, max_seen.visible_maps,
        );
        println!(
            "WORLD_BOUNDED_RESIDENCY_END maps={} worlds={} tables={} staged={} repoCached={} groundTextures={} groundResident={} visibleMaps={}",
            end.maps, end.worlds, end.tables, end.staged, end.repo_cached,
            end.ground_textures, end.ground_resident, end.visible_maps,
        );
    }
}
