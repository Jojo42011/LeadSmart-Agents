/**
 * Production entry: dashboard HTTP server + scrub poll loop.
 */
import * as dotenv from "dotenv";
import { initHull } from "./hull/index";

dotenv.config();
initHull();

import "./server";
import "./index";
