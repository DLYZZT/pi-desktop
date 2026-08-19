const net = require("node:net");

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3]);
if (!Number.isFinite(port)) {
  process.stderr.write("relay: need host port\n");
  process.exit(2);
}

const sock = net.connect(port, host);
sock.setNoDelay(true);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

sock.on("data", (chunk) => {
  process.stdout.write(chunk);
});
process.stdin.on("data", (chunk) => {
  sock.write(chunk);
});

function die(err) {
  if (err) process.stderr.write(`relay: ${err.message}\n`);
  process.exit(1);
}

sock.on("error", die);
sock.on("close", () => process.exit(0));
process.stdin.on("end", () => sock.end());
