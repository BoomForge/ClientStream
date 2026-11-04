// Production-only read-only acceptance test for the temporary service pause.
// Never signs up accounts or attempts a purchase.
const base = (process.env.CLIENTSTREAM_SMOKE_URL || "https://clientstream.theevansorrell.workers.dev").replace(/\/$/, "");
const expectedRevision = process.env.CLIENTSTREAM_EXPECT_REVISION || null;
async function test(path, options={}) {
  return fetch(base + path, { redirect:"manual", signal:AbortSignal.timeout(20000), ...options });
}
const health = await test("/api/health");
if(health.status !== 200)throw Error("Paused health endpoint unavailable: " + health.status);
const info=await health.json();
if(info.status!=="paused"||info.paused!==true||info.newRegistrations!==false||info.newCheckouts!==false)
 throw Error("ClientStream was not placed into paused mode.");
if(expectedRevision && info.revision!==expectedRevision)throw Error("Unexpected deployed revision: "+info.revision);

for(const path of ["/","/index.html","/signup","/report-error.html"]) {
  const res=await test(path,{headers:{"accept":"text/html"}});
  if(res.status!==503)throw Error(path+" should show paused page, not HTTP "+res.status);
  if((res.headers.get("x-clientstream-status")||"")!=="paused")throw Error("Missing pause header: "+path);
  const html=await res.text();
  if(!html.includes("ClientStream is taking a break")||!html.includes("Existing customer: billing and data access"))
    throw Error("Maintenance page inaccessible or missing customer cancellation/export details.");
}
const script=await test("/maintenance.js");
if(script.status!==200)throw Error("Customer cancellation/export helper not served.");

for(const path of ["/api/auth/register","/api/billing/checkout","/api/clients"]) {
  const res=await test(path,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  if(res.status!==503)throw Error("Paused mutation still available at "+path+" ("+res.status+")");
}
const referral=await test("/api/siteguard/referral?source=clientstream_website");
if(referral.status!==410||referral.headers.has("location"))throw Error("SiteGuard retirement route reactivated.");
const exportBlocked=await test("/api/account/export");
if(exportBlocked.status!==401)throw Error("Customer exports should require authentication.");
const billingBlocked=await test("/api/billing/status");
if(billingBlocked.status!==401)throw Error("Billing status should require authentication.");
console.log("CLIENTSTREAM PAUSED MODE VERIFIED: no registrations, checkouts or app access; authenticated billing/data endpoints retained; SiteGuard sale closed.");
