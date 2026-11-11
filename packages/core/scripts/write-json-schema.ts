import { writeFileSync } from "node:fs";
import { buildJsonSchema } from "../src/schema.ts";

const target = new URL("../schema/flow-snapshot.schema.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`);
