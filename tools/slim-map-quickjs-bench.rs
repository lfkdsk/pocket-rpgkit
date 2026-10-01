// Included into a scratch copy of PocketJS's desktop host. All map parsing,
// compact decoding, and repository validation execute in the shipping
// rquickjs Guest; Rust supplies only a monotonic clock.
#[cfg(test)]
mod slim_map_quickjs_bench {
    use super::*;
    use std::time::Instant;

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn run_case(
        guest: &Guest,
        pass: usize,
        name: &str,
        iterations: usize,
        rounds: usize,
    ) {
        let warm = format!("globalThis.__slimMapRun({name:?}, 5)");
        guest.with(|ctx| ctx.eval::<i32, _>(warm.as_str()).unwrap());

        let source = format!("globalThis.__slimMapRun({name:?}, {iterations})");
        let mut samples = Vec::with_capacity(rounds);
        for _ in 0..rounds {
            let started = Instant::now();
            guest.with(|ctx| ctx.eval::<i32, _>(source.as_str()).unwrap());
            samples.push(started.elapsed().as_secs_f64() * 1_000.0 / iterations as f64);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        println!(
            "SLIM_MAP_QJS pass={} case={} iterations={} rounds={} mean_ms={:.4} median_ms={:.4} p95_ms={:.4} min_ms={:.4} max_ms={:.4}",
            pass,
            name,
            iterations,
            rounds,
            mean,
            percentile(&samples, 0.5),
            percentile(&samples, 0.95),
            samples[0],
            samples[samples.len() - 1],
        );
    }

    #[test]
    #[ignore]
    fn first_visit() {
        let path = std::env::var("SLIM_MAP_QJS_JS").expect("SLIM_MAP_QJS_JS");
        let iterations = std::env::var("SLIM_MAP_QJS_ITERS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(30);
        let rounds = std::env::var("SLIM_MAP_QJS_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(9);
        assert!(iterations > 0, "SLIM_MAP_QJS_ITERS must be positive");
        assert!(rounds > 0, "SLIM_MAP_QJS_ROUNDS must be positive");
        let source = std::fs::read_to_string(path).unwrap();
        let guest = Guest::new().unwrap();
        guest.eval("slim-map-quickjs-bench", &source).unwrap();
        let info = guest.with(|ctx| {
            ctx.eval::<String, _>("globalThis.__slimMapInfo").unwrap()
        });
        println!("{}", info);

        // Mirror the repository's main/candidate interleave: the second pass
        // reverses each pair so thermal drift cannot consistently favour one
        // transport.
        for (pass, names) in [
            (1, ["jsonParse", "compactDecode", "jsonFirstVisit", "compactFirstVisit"]),
            (2, ["compactDecode", "jsonParse", "compactFirstVisit", "jsonFirstVisit"]),
        ] {
            for name in names {
                run_case(&guest, pass, name, iterations, rounds);
            }
        }
    }
}
