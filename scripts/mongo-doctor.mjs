// MongoDB Atlas connectivity doctor — isolates WHICH layer fails (DNS / TCP / TLS /
// driver) so a "tlsv1 alert internal error (SSL alert 80)" can be pinned to a cause.
//
//   node --env-file=.env scripts/mongo-doctor.mjs
//   (or)  MONGO_URI='mongodb+srv://…' node scripts/mongo-doctor.mjs
//
// Reads MONGO_URI from the environment (never printed). No writes, read-only.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("Set MONGO_URI (env or --env-file=.env).");
  process.exit(1);
}

const isSrv = /^mongodb\+srv:\/\//.test(uri);
const authority = uri.replace(/^mongodb(\+srv)?:\/\//, "").replace(/^[^@]*@/, "").split("/")[0];

let hosts = [];
if (isSrv) {
  const srvHost = authority.split(",")[0];
  console.log(`scheme: mongodb+srv  ·  SRV host: ${srvHost}`);
  try {
    const recs = await dns.resolveSrv("_mongodb._tcp." + srvHost);
    hosts = recs.map((r) => ({ host: r.name, port: r.port }));
    console.log(`DNS (SRV): OK  ->  ${hosts.map((h) => h.host + ":" + h.port).join(", ")}`);
  } catch (e) {
    console.log(`DNS (SRV): FAIL  ${e.code || e.message}`);
    console.log("  => this network's DNS can't resolve SRV. Fix: DNS 1.1.1.1/8.8.8.8, or use the standard (non-srv) connection string.");
    process.exit(2);
  }
} else {
  console.log(`scheme: mongodb (standard)  ·  hosts: ${authority}`);
  hosts = authority.split(",").map((hp) => {
    const [h, p] = hp.split(":");
    return { host: h, port: Number(p) || 27017 };
  });
}

function tcpTest({ host, port }) {
  return new Promise((res) => {
    const s = net.connect({ host, port, timeout: 6000 }, () => {
      console.log("  TCP: OK");
      s.end();
      res();
    });
    s.on("timeout", () => { console.log("  TCP: TIMEOUT  => port blocked / firewall"); s.destroy(); res(); });
    s.on("error", (e) => { console.log("  TCP: FAIL  " + (e.code || e.message)); res(); });
  });
}
function tlsTest({ host, port }) {
  return new Promise((res) => {
    const s = tls.connect({ host, port, servername: host, timeout: 8000 }, () => {
      const c = s.getPeerCertificate() || {};
      const issuer = (c.issuer && (c.issuer.O || c.issuer.CN)) || "?";
      console.log(`  TLS: OK  proto=${s.getProtocol()}  cert issuer="${issuer}"`);
      if (!/let's encrypt|amazon|digicert|globalsign|isrg/i.test(issuer))
        console.log(`       ^^ issuer isn't a public CA -> something is INTERCEPTING TLS (antivirus SSL-scan / proxy / VPN).`);
      s.end();
      res();
    });
    s.on("timeout", () => { console.log("  TLS: TIMEOUT"); s.destroy(); res(); });
    s.on("error", (e) => {
      console.log("  TLS: FAIL  " + (e.code || e.message));
      if (/alert number 80|internal error/i.test(String(e.message)))
        console.log("       ^^ 'alert 80' during handshake -> a middlebox (antivirus SSL-scan / DPI / VPN) or a paused/unhealthy cluster is rejecting TLS.");
      res();
    });
  });
}

for (const h of hosts) {
  console.log(`\n--- ${h.host}:${h.port} ---`);
  await tcpTest(h);
  await tlsTest(h);
}

console.log("\n--- MongoDB driver connect ---");
try {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  await client.db().command({ ping: 1 });
  console.log("DRIVER: OK — ping succeeded. Atlas is reachable; the app should show `store: mongo`.");
  await client.close();
} catch (e) {
  console.log("DRIVER: FAIL  " + e.message);
}

console.log(`
Read the result:
  DNS FAIL              -> SRV/DNS issue (use 1.1.1.1/8.8.8.8 or the standard connection string).
  TCP TIMEOUT          -> outbound 27017 blocked (firewall/network); try a mobile hotspot.
  TLS OK but issuer odd -> antivirus/proxy is MITM-ing TLS -> disable "SSL/encrypted scanning" or whitelist *.mongodb.net.
  TLS FAIL (alert 80)  -> middlebox rejecting TLS, OR the cluster is PAUSED -> resume it in Atlas, then re-run.
  Everything OK        -> it was transient; app will reconnect automatically.`);
