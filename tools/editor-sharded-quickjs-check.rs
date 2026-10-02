// Included into a scratch copy of PocketJS's desktop host by
// editor-sharded-quickjs-check.sh. Two checks run in the shipping QuickJS
// guest:
//
// - `guest_globals` prints what the guest realm actually provides: every
//   global name and, for each global object or constructor, the members
//   reachable through it (statics) and through its prototype. The guest
//   globals test compares source code against this inventory.
// - `sharded_open_paint_save` boots the editor bundle connected over
//   `--svc-connect` to the real filesystem companion (tools/editor-files.ts),
//   opens a sharded project, paints on two maps and saves. Mouse and key
//   lines enter exactly as the desktop window forwards them; the companion
//   writes the files, which the driver checks after this test exits.
#[cfg(test)]
mod editor_sharded_quickjs_check {
    use super::*;
    use serde_json::Value;
    use std::time::{Duration, Instant};

    const VIEWPORT: (u32, u32) = (480, 272);

    fn args(dist: &std::path::Path, scratch: &std::path::Path, app: String, svc: Option<String>) -> Args {
        Args {
            app,
            js: Some(dist.join("editor.js")),
            pak: Some(dist.join("editor.pak")),
            file: None,
            data_root: Some(scratch.join("data")),
            app_id: Some("dev.lfkdsk.pocket-rpgkit-editor-sharded-check".into()),
            title: "Sharded editor QuickJS check".into(),
            viewport: VIEWPORT,
            fixed: false,
            native_text: false,
            editor: false,
            companions: vec!["rpgkit-editor".into()],
            system: None,
            svc_connect: svc,
            density: 1,
            script: Vec::new(),
            quit_after_ticks: None,
            storm: None,
            announce_ready: false,
            trace_frames: false,
        }
    }

    fn env_path(name: &str) -> PathBuf {
        PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} is required")))
    }

    fn eval_json(rt: &Runtime, source: &str) -> Value {
        let text: String = rt.guest.with(|ctx| ctx.eval::<String, _>(source.to_string()).unwrap());
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    #[ignore]
    fn guest_globals() {
        let dist = env_path("POCKETJS_DIST");
        let scratch = env_path("SHARDED_QJS_SCRATCH").join("globals");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let rt = Runtime::boot(args(&dist, &scratch, "editor".into(), None)).unwrap();
        let inventory = eval_json(
            &rt,
            r#"
            JSON.stringify((() => {
              const names = (value) => {
                const out = new Set();
                for (let o = value; o !== null && o !== undefined; o = Object.getPrototypeOf(o)) {
                  for (const key of Object.getOwnPropertyNames(o)) out.add(key);
                }
                return [...out].sort();
              };
              const globals = Object.getOwnPropertyNames(globalThis).sort();
              const members = {};
              for (const name of globals) {
                let value;
                try { value = globalThis[name]; } catch { continue; }
                if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;
                members[name] = names(value);
                const proto = typeof value === "function" ? value.prototype : undefined;
                if (proto !== null && typeof proto === "object") members[`${name}.prototype`] = names(proto);
              }
              return { globals, members };
            })())
            "#,
        );
        println!("SHARDED_QJS_GLOBALS {}", inventory);
    }

    struct Session {
        rt: Runtime,
    }

    impl Session {
        fn tick(&mut self) {
            self.rt.tick().unwrap();
        }

        fn push(&mut self, line: Value) {
            self.rt.surface.svc_push(line.to_string());
            self.tick();
        }

        fn click(&mut self, x: i64, y: i64) {
            self.push(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": true, "b": 0}));
            self.push(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false, "b": 0}));
        }

        fn key(&mut self, k: &str, cmd: bool) {
            self.push(serde_json::json!({"t": "key", "k": k, "cmd": cmd, "sh": false, "alt": false, "ctl": cmd}));
        }

        fn state(&self) -> Value {
            eval_json(
                &self.rt,
                r#"
                JSON.stringify((() => {
                  const s = globalThis.__rpgkitEditorState();
                  const map = s.editor.project.maps[0];
                  return {
                    sharded: s.sharded,
                    catalogCount: s.catalogCount,
                    catalogIndex: s.catalogIndex,
                    loadingMapIndex: s.loadingMapIndex,
                    loadedMapIds: s.loadedMapIds,
                    dirtyMapIds: s.dirtyMapIds,
                    savePending: s.savePending,
                    dirty: s.editor.dirty,
                    notice: s.notice,
                    mapListOpen: s.mapListOpen,
                    mapListCursor: s.mapListCursor,
                    map: map.id,
                    first: map.ground[0],
                  };
                })())
                "#,
            )
        }

        /// Ticks in real time until `done` holds: shard reads and saves
        /// cross a TCP socket to the companion process.
        fn wait(&mut self, what: &str, done: impl Fn(&Value) -> bool) -> Value {
            let started = Instant::now();
            loop {
                self.tick();
                let state = self.state();
                if done(&state) {
                    return state;
                }
                if started.elapsed() > Duration::from_secs(20) {
                    panic!("{what}: timed out; last state {state}");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    fn coordinate(plan: &Value, key: &str) -> (i64, i64) {
        (plan[key][0].as_i64().unwrap(), plan[key][1].as_i64().unwrap())
    }

    #[test]
    #[ignore]
    fn sharded_open_paint_save() {
        let dist = env_path("POCKETJS_DIST");
        let scratch = env_path("SHARDED_QJS_SCRATCH").join("session");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let addr = std::env::var("SHARDED_QJS_ADDR").expect("SHARDED_QJS_ADDR");
        let token = std::env::var("SHARDED_QJS_TOKEN").expect("SHARDED_QJS_TOKEN");
        let plan: Value = serde_json::from_str(&std::env::var("SHARDED_QJS_PLAN").expect("SHARDED_QJS_PLAN")).unwrap();
        let painted = plan["painted"].as_str().unwrap().to_string();
        let last_index = plan["lastIndex"].as_u64().unwrap();
        let rt = Runtime::boot(args(&dist, &scratch, token, Some(addr))).unwrap();
        let mut session = Session { rt };

        // Open: the companion sends the shell at connect, the editor asks
        // for the start map's shard.
        let opened = session.wait("open", |s| {
            s["sharded"] == true && s["loadingMapIndex"].is_null() && s["loadedMapIds"].as_array().is_some_and(|ids| ids.len() == 1)
        });
        println!("SHARDED_QJS step=open state={opened}");
        assert_eq!(opened["catalogIndex"].as_u64(), Some(0), "start map: {opened}");

        // Paint the top-left cell of map 0 with the second palette tile.
        let (tx, ty) = coordinate(&plan, "tile");
        let (cx, cy) = coordinate(&plan, "cell");
        session.click(tx, ty);
        session.click(cx, cy);
        let first = session.state();
        println!("SHARDED_QJS step=paint-first state={first}");
        assert_eq!(first["first"].as_str(), Some(painted.as_str()), "first paint: {first}");
        assert_eq!(first["dirty"].as_bool(), Some(true));

        // Switch to the last map through the map list (End + Enter); the
        // first map's edit moves into the workspace and the next shard loads.
        let (mx, my) = coordinate(&plan, "mapButton");
        session.click(mx, my);
        session.key("End", false);
        session.key("Enter", false);
        let switched = session.wait("switch", |s| {
            s["catalogIndex"].as_u64() == Some(last_index) && s["loadingMapIndex"].is_null()
        });
        println!("SHARDED_QJS step=switch state={switched}");
        assert_eq!(switched["dirtyMapIds"].as_array().map(Vec::len), Some(1), "after switch: {switched}");

        session.click(tx, ty);
        session.click(cx, cy);
        let second = session.state();
        println!("SHARDED_QJS step=paint-last state={second}");
        assert_eq!(second["first"].as_str(), Some(painted.as_str()), "second paint: {second}");

        // Save: Ctrl+S writes the two dirty shards and the shell.
        session.key("s", true);
        let saved = session.wait("save", |s| s["savePending"] == false && s["notice"]["kind"] != "info");
        println!("SHARDED_QJS step=save state={saved}");
        assert_eq!(saved["notice"]["kind"].as_str(), Some("good"), "save: {saved}");
        assert_eq!(saved["dirtyMapIds"].as_array().map(Vec::len), Some(0), "after save: {saved}");
        assert_eq!(saved["dirty"].as_bool(), Some(false), "after save: {saved}");
        println!("SHARDED_QJS PASS");
    }
}
