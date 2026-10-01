// Included into a scratch copy of PocketJS's desktop host by
// qoa-quickjs-bench.sh. Measurements run inside the shipping QuickJS Guest.
#[cfg(test)]
mod qoa_quickjs_bench {
    use super::*;
    use std::collections::BTreeMap;
    use std::time::Instant;

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    #[test]
    #[ignore]
    fn stream_decode() {
        let path = std::env::var("QOA_BENCH_JS").expect("QOA_BENCH_JS");
        let iterations = std::env::var("QOA_BENCH_ITERS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(2_000);
        let rounds = std::env::var("QOA_BENCH_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(11);
        let source = std::fs::read_to_string(path).unwrap();
        let guest = Guest::new().unwrap();
        guest.eval("qoa-quickjs-entry", &source).unwrap();
        for name in ["control", "stream368"] {
            let warm = format!("globalThis.__qoaRun({name:?}, 200)");
            guest.with(|ctx| ctx.eval::<i32, _>(warm.as_str()).unwrap());
        }

        let mut samples: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
        for round in 0..rounds {
            let order = if round % 2 == 0 {
                ["control", "stream368"]
            } else {
                ["stream368", "control"]
            };
            for name in order {
                let expression = format!("globalThis.__qoaRun({name:?}, {iterations})");
                let started = Instant::now();
                guest.with(|ctx| ctx.eval::<i32, _>(expression.as_str()).unwrap());
                samples
                    .entry(name)
                    .or_default()
                    .push(started.elapsed().as_secs_f64() * 1_000_000.0 / iterations as f64);
            }
        }

        for name in ["control", "stream368"] {
            let values = samples.get_mut(name).unwrap();
            values.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            println!(
                "QOA_QJS case={} frames=368 iterations={} rounds={} mean_us={:.3} median_us={:.3} p95_us={:.3} min_us={:.3} max_us={:.3} pct_of_16ms={:.3}",
                name,
                iterations,
                rounds,
                mean,
                percentile(values, 0.5),
                percentile(values, 0.95),
                values[0],
                values[values.len() - 1],
                mean / 16_666.67 * 100.0,
            );
        }
    }
}
