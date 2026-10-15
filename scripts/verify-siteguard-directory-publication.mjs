// Verification only. The feed was already submitted. Never POST it twice.
const page = "https://rssamplifier.com/siteguard-by-clientstream-website-monitoring-advice";
const status = "https://rssamplifier.com/submissions/a9d76019-2eec-4a16-9e15-c390f02c0292";
for (const [kind, url] of [["submission",status],["public-listing",page]]) {
 try {
   const response=await fetch(url,{redirect:"follow",signal:AbortSignal.timeout(20000),headers:{"user-agent":"SiteGuard-Directory-Verification/1.0"}});
   const body=await response.text();
   console.log("SITEGUARD DIRECTORY",kind,"status",response.status,"url",response.url);
   console.log("SITEGUARD DIRECTORY",kind,"response:",body.slice(0,650).replace(/\s+/g," "));
   if(kind==="public-listing" && response.ok &&
     /siteguard|clientstream|website monitoring/i.test(body)){
       console.log("SITEGUARD RSS PUBLIC DIRECTORY LISTING VERIFIED",page);
       process.exit(0);
   }
 } catch(e) {console.log(kind,"could not be checked:",e.message)}
}
console.log("SiteGuard RSS submission accepted but public listing not yet verified; do not count as live.");
