// Verify production is closed to new SiteGuard customers after deployment.
// Do not call the independent retired monitoring origin or a Whop checkout.
const checks = [
  {url:"https://app.clientstream.io/api/siteguard/referral?source=clientstream_website&probe=1", status:410, kind:"api"},
  {url:"https://app.clientstream.io/siteguard.html",status:200,kind:"html"}
];
for(const check of checks) {
  const response=await fetch(check.url,{redirect:check.kind==="html"?"follow":"manual",signal:AbortSignal.timeout(18000),
    headers:{"user-agent":"ClientStream-SiteGuard-RetirementCheck/1.0"}});
  if(response.status!==check.status) throw Error(check.kind+" expected HTTP "+check.status+"; got "+response.status);
  if(check.kind==="api" && response.headers.has("location"))throw Error("Retired SiteGuard still redirects new customers.");
  if(check.kind==="html" && new URL(response.url).origin!=="https://app.clientstream.io") throw Error("Retirement notice unexpectedly redirected off ClientStream.");
  const body=await response.text();
  if(check.kind==="api") {
    const data=JSON.parse(body);
    if(data.status!=="retired"||data.available_for_purchase!==false)throw Error("Sales guard is not active.");
  } else if(!body.includes("no longer available for new subscriptions")||body.includes("whop.com/checkout/")) {
    throw Error("SiteGuard public page still advertises sales.");
  }
  console.log("SITEGUARD RETIREMENT VERIFIED",check.kind,response.status);
}
