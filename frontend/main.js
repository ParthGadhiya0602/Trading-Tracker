// Entry point: load each module via its index. Cross-module bridges still use window.*
import "./modules/dashboard/index.js";
import "./modules/alerts/index.js";
import "./modules/trades/index.js";
import "./modules/reports/index.js";
import "./modules/market/index.js";
import "./modules/derivatives/index.js";
import "./modules/shell/index.js";
import "./modules/auth/index.js";
