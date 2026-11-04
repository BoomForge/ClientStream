// Production-only read-only acceptance test for the temporary service pause.
// Never signs up accounts or attempts a purchase.
const base = (process.env.CLIENTSTREAM_SMOKE_URL || "https://clientstream.theevansorrell.workers.dev").replace(/\/$/, "");
const expectedRevision = process.env.CLIENTSTREAM_EXPECT_REVISION || null;
async function test(path, options={}) {
  return fetch(base + path, { redirect:"manual", signal:AbortSignal.timeout(20000), ...options });
}
// Cloudflare can briefly return the previously deployed version while the
// new Worker propagates. Retry read-only health until the intended revision
// and paused state are both confirmed, instead of treating a transient old
// response as a failed retirement.
let info = null;
for(let attempt=1;attempt<=45;attempt++) {
  try {
    const health=await test("/api/health?pause_probe="+attempt,{cache:"no-store"});
    const body=await health.json();
    info=body;
    if(health.status===200 && body.status==="paused" && body.paused===true &&
        body.newRegistrations===false && body.newCheckouts===false &&
        (!expectedRevision || body.revision===expectedRevision))break;
  } catch(error) {
    if(attempt===45)throw error;
  }
  if(attempt<45)await new Promise(resolve=>setTimeout(resolve,1000));
}
if(info?.status!=="paused"||info?.paused!==true||info?.newRegistrations!==false||info?.newCheckouts!==false)
  throw Error("Expected ClientStream paused mode; observed status "+JSON.stringify(info?.status)+
    " and revision "+JSON.stringify(info?.revision));
if(expectedRevision && info.revision!==expectedRevision)
  throw Error("Expected deployment revision "+expectedRevision+"; observed "+info.revision);

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
