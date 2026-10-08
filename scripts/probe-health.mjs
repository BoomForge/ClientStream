const url = process.env.CLIENTSTREAM_HEALTH_URL || "https://clientstream.theevansorrell.workers.dev/api/health";
const attempts = 3;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body.status !== "ok" || body.service !== "clientstream" || !body.version) {
      throw Error("Invalid API health response (" + response.status + ")");
    }
    console.log("ClientStream API healthy, reported version:", body.version);
    process.exit(0);
  } catch (error) {
    console.error("Health check attempt " + attempt + " failed:", error.message);
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
throw Error("ClientStream health endpoint failed all checks.");
