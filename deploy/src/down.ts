import { KIND_CLUSTER } from "./cluster.js";
import { has, run } from "./shell.js";

/** Huỷ cụm kind của UDP — cùng với nó là dữ liệu PostgreSQL và Secret (Plan #49) */
if (!has("kind")) throw new Error("Thiếu kind trên PATH");
run("kind", ["delete", "cluster", "--name", KIND_CLUSTER]);
