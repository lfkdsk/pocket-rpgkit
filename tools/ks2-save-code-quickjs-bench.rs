// Included into a scratch copy of PocketJS's desktop host by
// ks2-save-code-quickjs-bench.sh. Measurements run inside the shipping
// QuickJS Guest.
#[cfg(test)]
mod ks2_save_code_quickjs_bench {
    use super::*;
    use std::time::Instant;

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn quote(text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 2);
        out.push('"');
        for c in text.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    #[test]
    #[ignore]
    fn save_codes() {
        let path = std::env::var("KS2_BENCH_JS").expect("KS2_BENCH_JS");
        let iterations = std::env::var("KS2_BENCH_ITERS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(20);
        let rounds = std::env::var("KS2_BENCH_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(9);
        let source = std::fs::read_to_string(path).unwrap();
        let guest = Guest::new().unwrap();
        guest.eval("ks2-save-code-quickjs-entry", &source).unwrap();
        let mut names = vec!["sunstone".to_string(), "large".to_string()];
        if let Ok(extra) = std::env::var("KS2_BENCH_ENVELOPE") {
            let text = std::fs::read_to_string(&extra).unwrap();
            let call = format!("globalThis.__ks2Add(\"external\", {})", quote(&text));
            guest.with(|ctx| ctx.eval::<String, _>(call.as_str()).unwrap());
            names.push("external".to_string());
        }
        let sizes = guest.with(|ctx| ctx.eval::<String, _>("globalThis.__ks2Sizes()").unwrap());
        for line in sizes.lines() {
            println!("KS2_QJS_SIZE {line}");
        }
        let ops = ["encode", "decode", "encodePlain", "decodePlain", "deflate", "inflate"];
        for name in &names {
            for op in ops {
                let warm = format!("globalThis.__ks2Run({name:?}, {op:?}, 3)");
                guest.with(|ctx| ctx.eval::<f64, _>(warm.as_str()).unwrap());
                let mut values = Vec::with_capacity(rounds);
                for _ in 0..rounds {
                    let expression = format!("globalThis.__ks2Run({name:?}, {op:?}, {iterations})");
                    let started = Instant::now();
                    guest.with(|ctx| ctx.eval::<f64, _>(expression.as_str()).unwrap());
                    values.push(started.elapsed().as_secs_f64() * 1_000.0 / iterations as f64);
                }
                values.sort_by(|a, b| a.partial_cmp(b).unwrap());
                println!(
                    "KS2_QJS input={} op={} iterations={} rounds={} median_ms={:.3} p95_ms={:.3} min_ms={:.3} max_ms={:.3}",
                    name,
                    op,
                    iterations,
                    rounds,
                    percentile(&values, 0.5),
                    percentile(&values, 0.95),
                    values[0],
                    values[values.len() - 1],
                );
            }
        }
    }
}
