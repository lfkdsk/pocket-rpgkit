// Included into a scratch copy of PocketJS's desktop host by
// kr2-quickjs-bench.sh. All timed engine work executes inside the shipping
// rquickjs Guest; Rust provides only a monotonic clock and reports samples.
#[cfg(test)]
mod kr2_quickjs_bench {
    use super::*;
    use pocket_mod::qjs::Function;
    use serde::Deserialize;
    use std::time::Instant;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RewindSample {
        before: usize,
        after: usize,
        last_refold_start: usize,
        last_refold_frames: usize,
        keyframes: usize,
        keyframe_bytes: usize,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FrameProfile {
        frames: usize,
        steady_mean_ms: f64,
        steady_max_ms: f64,
        plain_mean_ms: f64,
        plain_max_ms: f64,
        keyframe_spike_ms: f64,
        keyframe_count: usize,
        keyframe_bytes: usize,
    }

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn install_clock(guest: &Guest, origin: Instant) {
        guest
            .mount("kr2Clock", move |ctx, namespace| {
                namespace.set(
                    "now",
                    Function::new(ctx.clone(), move || origin.elapsed().as_secs_f64() * 1_000.0)?,
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn eval_json<T: for<'de> Deserialize<'de>>(guest: &Guest, source: &str) -> T {
        let text = guest
            .with(|ctx| ctx.eval::<String, _>(source).expect("QuickJS benchmark call"));
        serde_json::from_str(&text).expect("QuickJS benchmark JSON")
    }

    fn rewind_samples(guest: &Guest, name: &str, rounds: usize) -> (Vec<f64>, RewindSample) {
        let source = format!("globalThis.__kr2Rewind({name:?})");
        let _: RewindSample = eval_json(guest, &source); // warm caches and release/refill path
        let mut elapsed = Vec::with_capacity(rounds);
        let mut last = None;
        for _ in 0..rounds {
            let started = Instant::now();
            let sample = eval_json(guest, &source);
            elapsed.push(started.elapsed().as_secs_f64() * 1_000.0);
            last = Some(sample);
        }
        elapsed.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (elapsed, last.unwrap())
    }

    #[test]
    #[ignore]
    fn rewind_keyframes() {
        let path = std::env::var("KR2_BENCH_JS").expect("KR2_BENCH_JS");
        let rounds = std::env::var("KR2_BENCH_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(7);
        let source = std::fs::read_to_string(path).unwrap();
        let guest = Guest::new().unwrap();
        install_clock(&guest, Instant::now());
        guest.eval("kr2-quickjs-bench", &source).unwrap();

        for name in ["short", "long"] {
            let (times, sample) = rewind_samples(&guest, name, rounds);
            assert!(sample.last_refold_frames <= 3_600);
            println!(
                "KR2_QJS_REWIND case={} rounds={} timeline_before={} timeline_after={} refold_start={} refold_frames={} keyframes={} keyframe_bytes={} min_ms={:.3} median_ms={:.3} p95_ms={:.3} max_ms={:.3}",
                name,
                rounds,
                sample.before,
                sample.after,
                sample.last_refold_start,
                sample.last_refold_frames,
                sample.keyframes,
                sample.keyframe_bytes,
                times[0],
                percentile(&times, 0.5),
                percentile(&times, 0.95),
                times[times.len() - 1],
            );
        }

        let profile: FrameProfile = eval_json(&guest, "globalThis.__kr2ProfileFrames()");
        assert!(profile.keyframe_count >= 1);
        assert!(profile.keyframe_spike_ms <= 5.0);
        println!(
            "KR2_QJS_FRAME frames={} keyed_steady_mean_ms={:.4} keyed_steady_max_ms={:.4} no_keyframe_mean_ms={:.4} no_keyframe_max_ms={:.4} keyframe_spike_ms={:.4} keyframes={} keyframe_bytes={}",
            profile.frames,
            profile.steady_mean_ms,
            profile.steady_max_ms,
            profile.plain_mean_ms,
            profile.plain_max_ms,
            profile.keyframe_spike_ms,
            profile.keyframe_count,
            profile.keyframe_bytes,
        );
    }
}
