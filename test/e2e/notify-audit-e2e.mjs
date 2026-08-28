import fs from "node:fs";
import { sendNotification } from "../../extensions/notify.js";

const logFile = `${process.env.HOME}/.waywiser/audit/notify.log`;
const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).length : 0;

// 1. suppressed by quiet hours (it's 00:41, quiet 22:00-07:00)
const r1 = await sendNotification("e2e quiet", "should be suppressed", undefined, { urgency: "normal" });
// 2. sent (critical bypasses quiet)
const r2 = await sendNotification("e2e critical", "audit line check — ignore", ["termux"], { urgency: "critical", bypassQuiet: true });

const after = fs.readFileSync(logFile, "utf8").trim().split("\n");
const fresh = after.slice(before);
console.log("sent1:", JSON.stringify(r1), "sent2:", JSON.stringify(r2));
console.log("fresh log lines:");
fresh.forEach((l) => console.log(" ", l));
const okQuiet = fresh.some((l) => l.includes("suppressed-quiet"));
const okSent = fresh.some((l) => l.includes(" sent ") || l.includes("sent channels"));
// (allow 'sent channels=termux' or 'failed' if termux api down)
const ok = okQuiet && after.slice(before).some((l) => / (sent|failed) /.test(l));
console.log(ok ? "AUDIT-E2E-PASS" : "AUDIT-E2E-FAIL");
process.exit(ok ? 0 : 1);
