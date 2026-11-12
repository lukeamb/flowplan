import { setField } from "@flowplan/core";
import { sampleSnapshot } from "../../../core/test/fixtures.ts";
import { connect, disconnect, start, tempRoot, writeFlow } from "../helpers.ts";

const root = tempRoot();
await writeFlow(root, "main", sampleSnapshot());
const { server } = await start({ root, debounceMs: 60_000 });
const client = await connect(server, "main");
setField(client.doc, "agent", "b_api", "title", "late");
await new Promise((resolve) => setTimeout(resolve, 50));
await server.close();
disconnect(client);
