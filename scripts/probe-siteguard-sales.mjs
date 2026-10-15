// Check the real sales funnel, not merely a local page or configured redirect.
// Uses only public GET requests; never starts a checkout or sends user data.
const urls = [
  "https://siteguard.clientstream.io/",
  "https://app.clientstream.io/api/siteguard/referral?source=clientstream_website&probe=1"
];
for (const url of (process.env.SITEGUARD_ONLY_ORIGIN === "true" ? urls.slice(0, 1) : urls)) {
  let succeeded = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(18000),
        headers: { "user-agent": "ClientStream-SiteGuard-FunnelHealth/1.0" }
      });
      if (!response.ok) throw Error("HTTP " + response.status);
      const location = new URL(response.url);
      if (location.protocol !== "https:") throw Error("Sales funnel redirected to insecure HTTP.");
      if (!/text\/html/i.test(response.headers.get("content-type") || "")) {
        throw Error("Sales funnel did not return HTML.");
      }
      const body = await response.text();
      if (body.length < 120) throw Error("Sales funnel returned an unexpectedly short page.");
      console.log("SITEGUARD FUNNEL VERIFIED: HTTP", response.status, "URL", location.origin + location.pathname,
        "entry", url.includes("/api/siteguard/referral") ? "campaign-tagged" : "canonical");
      succeeded = true;
      break;
    } catch (error) {
      console.error("SiteGuard funnel attempt " + attempt + " failed:", error.message);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!succeeded) throw Error("SiteGuard sales funnel failed health check: " + (url.includes("utm_source") ? "campaign-tagged" : "canonical"));
}
console.log("SITEGUARD PRODUCTION SALES PATHS VERIFIED");
