// Included into a scratch copy of PocketJS's desktop host by
// grow-quickjs-bench.sh. All timed grow-simulation work executes inside the
// shipping rquickjs Guest (grow-quickjs-entry.ts); Rust provides only a
// monotonic clock, reads QuickJS heap usage between calls, and prints one
// `GROW_QJS <json>` line per measurement.
#[cfg(test)]
mod grow_quickjs_bench {
    use super::*;
    use pocket_mod::qjs::{Function, qjs as sys};
    use serde_json::{Value, json};
    use std::time::Instant;

    fn install_clock(guest: &Guest, origin: Instant) {
        guest
            .mount("growClock", move |ctx, namespace| {
                namespace.set(
                    "now",
                    Function::new(ctx.clone(), move || origin.elapsed().as_secs_f64() * 1_000.0)?,
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn eval_json(guest: &Guest, source: &str) -> Value {
        let text = guest.with(|ctx| match ctx.eval::<String, _>(source) {
            Ok(text) => text,
            Err(error) => {
                let detail = ctx.catch();
                panic!("QuickJS call {source} failed: {error}: {detail:?}");
            }
        });
        serde_json::from_str(&text).expect("QuickJS benchmark JSON")
    }

    fn eval_unit(guest: &Guest, source: &str) {
        guest.with(|ctx| ctx.eval::<(), _>(source).expect("QuickJS benchmark call"));
    }

    /// Full GC, then QuickJS's own accounting: (memory_used_size, malloc_size)
    /// in bytes. Typed-array backing stores are js_malloc'd, so they count.
    fn heap(guest: &Guest) -> (i64, i64) {
        guest.with(|ctx| unsafe {
            let rt = sys::JS_GetRuntime(ctx.as_raw().as_ptr());
            sys::JS_RunGC(rt);
            let mut usage = std::mem::MaybeUninit::<sys::JSMemoryUsage>::uninit();
            sys::JS_ComputeMemoryUsage(rt, usage.as_mut_ptr());
            let usage = usage.assume_init();
            (usage.memory_used_size, usage.malloc_size)
        })
    }

    fn emit(label: &str, mut row: Value) {
        row.as_object_mut().unwrap().insert("label".into(), json!(label));
        println!("GROW_QJS {row}");
    }

    #[test]
    #[ignore]
    fn grow() {
        let path = std::env::var("GROW_QJS_JS").expect("GROW_QJS_JS");
        let label = std::env::var("GROW_QJS_LABEL").unwrap_or_else(|_| "run".into());
        let source = std::fs::read_to_string(path).unwrap();
        let guest = Guest::new().unwrap();
        install_clock(&guest, Instant::now());
        guest.eval("grow-quickjs-entry", &source).unwrap();

        let names: Vec<String> =
            serde_json::from_value(eval_json(&guest, "globalThis.__growNames()")).unwrap();
        assert!(!names.is_empty(), "grow module exports none of STAMP_PARAMS / DEFAULT_PARAMS");

        for name in &names {
            eval_unit(&guest, "globalThis.__growRelease()");
            let (base_used, base_malloc) = heap(&guest);

            emit(&label, eval_json(&guest, &format!("globalThis.__growFold({name:?})")));
            let (done_used, _) = heap(&guest);
            eval_unit(&guest, "globalThis.__growRelease()");

            emit(&label, eval_json(&guest, &format!("globalThis.__growTimeline({name:?})")));
            let (timeline_used, _) = heap(&guest);

            emit(&label, eval_json(&guest, &format!("globalThis.__growSeek({name:?})")));
            let (seek_used, seek_malloc) = heap(&guest);
            eval_unit(&guest, "globalThis.__growRelease()");

            // Retained bytes above the post-GC baseline: the terminal fold
            // state alone, the fully materialized timeline, and the timeline
            // plus its seek cursor.
            emit(
                &label,
                json!({
                    "kind": "heap",
                    "name": name,
                    "baseline_used_bytes": base_used,
                    "done_state_bytes": done_used - base_used,
                    "timeline_bytes": timeline_used - base_used,
                    "timeline_seek_bytes": seek_used - base_used,
                    "timeline_seek_malloc_bytes": seek_malloc - base_malloc,
                }),
            );
        }
    }
}
