// Verify SiteGuard sales links are closed even while ClientStream is paused.
// Never open an actual Whop checkout or the independent monitoring origin.
const url="https://app.clientstream.io/api/siteguard/referral?source=clientstream_website&probe=1";
const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(18000),
  headers:{"user-agent":"ClientStream-SiteGuard-RetirementCheck/1.0"}});
if(response.status!==410||response.headers.has("location"))
  throw Error("SiteGuard referral must return HTTP 410 without checkout redirect (got "+response.status+").");
const data=await response.json();
if(data.status!=="retired"||data.available_for_purchase!==false)
  throw Error("SiteGuard checkout guard is not active.");
console.log("SITEGUARD SALE RETIREMENT VERIFIED: HTTP 410, no redirect or purchase.");
