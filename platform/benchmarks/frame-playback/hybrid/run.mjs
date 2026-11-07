// Run only against the isolated, authenticated hybrid benchmark.
const base = new URL(process.env.HYBRID_BENCHMARK_URL);
const token = process.env.HYBRID_BENCHMARK_TOKEN;
if (
  !token ||
  base.protocol !== "https:" ||
  base.port ||
  base.username ||
  !/^video2ctx-hybrid-probe-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(
    base.hostname,
  )
) {
  throw new Error(
    "Set HYBRID_BENCHMARK_URL and HYBRID_BENCHMARK_TOKEN for the temporary Worker.",
  );
}

for (const key of ["a-first", "a-seek", "b-first", "b-seek"]) {
  const started = Date.now();
  try {
    const response = await fetch(new URL(key, base), {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(125_000),
    });
    const result = await response.json();
    const clientMs = Date.now() - started;
    // Image bytes are verified by the Worker but never printed by this runner.
    result.frames = (result.frames ?? []).map(
      ({ imageBase64, ...frame }) => frame,
    );
    console.log(
      JSON.stringify({ ...result, httpStatus: response.status, clientMs }),
    );
    if (
      !response.ok ||
      !result.verified ||
      result.path !== "hosted-container-worker-media" ||
      result.reuse !== key.endsWith("-seek")
    )
      process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        key,
        error: error.name,
        clientMs: Date.now() - started,
      }),
    );
    process.exitCode = 1;
  }
}
