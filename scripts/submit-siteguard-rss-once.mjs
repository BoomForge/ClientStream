// One-time, permissioned registration on an open, no-account directory
// expressly accepting public Atom feeds through its automation API.
// Do not batch, retry submissions, or invent a public listing URL.
const feed = "https://app.clientstream.io/siteguard-feed.xml";
const endpoint = "https://rssamplifier.com/api/submit";
const feedResponse = await fetch(feed, {signal:AbortSignal.timeout(20000)});
if (!feedResponse.ok) throw Error("SiteGuard Atom feed not publicly accessible: HTTP " + feedResponse.status);
const feedText = await feedResponse.text();
if (!feedText.includes("<feed") || !feedText.includes("SiteGuard by ClientStream")) {
  throw Error("The public SiteGuard feed cannot be validated. No submission made.");
}
const response = await fetch(endpoint,{
  method:"POST",
  headers:{"content-type":"application/json","accept":"application/json","user-agent":"SiteGuard-Feed-Registration/1.0"},
  body:JSON.stringify({url:feed}),
  signal:AbortSignal.timeout(25000)
});
const raw=await response.text();
console.log("RSS AMPLIFIER API RESPONSE HTTP",response.status);
console.log("RSS AMPLIFIER SUBMISSION RECEIPT",raw.slice(0,2000));
if(!response.ok) throw Error("Public directory did not accept the one-time free feed submission.");
let data;
try {data=JSON.parse(raw)}catch {throw Error("Submission may have succeeded, but receipt cannot be parsed; no verified listing.");}
const direct=[
 data?.slug,data?.feed?.slug,data?.result?.slug,data?.results?.[0]?.slug,data?.added?.[0]?.slug,
 data?.feeds?.[0]?.slug,data?.feed?.url,data?.result?.url
].filter(v=>typeof v==="string");
const urls=[...new Set(direct.map(slug=>{
 if (slug.startsWith("https://rssamplifier.com/")) return slug;
 if (/^[a-zA-Z0-9][a-zA-Z0-9-]{2,120}$/.test(slug)) return "https://rssamplifier.com/"+slug;
 return null;
}).filter(Boolean))];
for(const url of urls) {
 try {
  const check=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:"follow"});
  if(!check.ok) continue;
  const html=await check.text();
  if(!/siteguard|clientstream|website monitoring/i.test(html)) continue;
  console.log("SITEGUARD RSS DIRECTORY LISTING PUBLICLY VERIFIED:",url,"HTTP",check.status);
  process.exit(0);
 }catch(e){console.log("Directory verification request failed:",e.message)}
}
console.log("No public SiteGuard directory page independently verified from submission response.");
console.log("Submission status is NOT proof of public publication; do not count as a live listing.");
process.exitCode=2;
