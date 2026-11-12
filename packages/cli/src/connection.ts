import type { ServerInfo } from "@flowplan/server";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { CliError } from "./errors.ts";
import { serverUrl } from "./server-process.ts";

export type FlowConnection = {
	doc: Y.Doc;
	provider: WebsocketProvider;
	close(): Promise<void>;
};

const CLOSE_TIMEOUT_MS = 3000;

export async function openFlow(info: ServerInfo, flow: string, timeoutMs = 5000): Promise<FlowConnection> {
	const doc = new Y.Doc();
	const provider = new WebsocketProvider(serverUrl(info.port), flow, doc, {
		params: { token: info.token },
		disableBc: true,
		connect: false,
		shouldReconnect: () => false,
	});
	provider.awareness.setLocalState(null);
	let destroyed = false;
	const destroy = () => {
		if (destroyed) return;
		destroyed = true;
		provider.destroy();
		doc.destroy();
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const fail = () =>
				reject(
					new CliError(
						`could not open flow '${flow}' on the flowplan server at 127.0.0.1:${info.port}. ` +
							"The flow may not have loaded (see .flowplan/server.log), or .flowplan/server.json may be stale.",
					),
				);
			const timer = setTimeout(fail, timeoutMs);
			provider.on("sync", (synced: boolean) => {
				if (synced) {
					clearTimeout(timer);
					resolve();
				}
			});
			const onClose = () => {
				clearTimeout(timer);
				provider.off("connection-close", onClose);
				fail();
			};
			provider.on("connection-close", onClose);
			provider.on("sync", () => provider.off("connection-close", onClose));
			provider.connect();
		});
	} catch (error) {
		destroy();
		throw error;
	}

	let closed: Promise<void> | undefined;
	return {
		doc,
		provider,
		close: () => {
			closed ??= new Promise<void>((resolve) => {
				let finished = false;
				const done = () => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					provider.off("connection-close", done);
					destroy();
					resolve();
				};
				const timer = setTimeout(done, CLOSE_TIMEOUT_MS);
				if (!provider.wsconnected) return done();
				provider.on("connection-close", done);
				provider.disconnect();
			});
			return closed;
		},
	};
}
