import * as dotenv from "dotenv";
import { startPollScheduler } from "./lib/pollScheduler";

dotenv.config();

const runOnce = process.argv.includes("--once");

process.on("uncaughtException", () => {
  // keep process alive
});

process.on("unhandledRejection", () => {
  // keep process alive
});

void startPollScheduler({ runOnce });
