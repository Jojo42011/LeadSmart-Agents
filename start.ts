/**
 * Production entry: dashboard HTTP server + scrub poll loop.
 */
import * as dotenv from "dotenv";
import { initHull } from "./hull/index";
import { warnMissingPaymentEnvVars } from "./lib/paymentEnv";

dotenv.config();
initHull();
warnMissingPaymentEnvVars();

import "./server";
import "./index";
