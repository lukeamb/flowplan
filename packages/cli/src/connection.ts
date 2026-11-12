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

	let lost: string | undefined;
	provider.on("connection-close", (event: CloseEvent | null) => {
		if (event && lost === undefined) lost = describeClose(event);
	});

	let closed: Promise<void> | undefined;
	return {
		doc,
		provider,
		close: () => {
			closed ??= new Promise<void>((resolve, reject) => {
				const fail = (reason: string) => {
					destroy();
					reject(new CliError(`the flowplan server did not apply the edit: ${reason}`));
				};
				const socket = provider.ws;
				if (lost !== undefined || !socket || socket.readyState === socket.CLOSED) {
					return fail(lost ?? "the connection was already closed");
				}
				const timer = setTimeout(() => fail("the server did not confirm the close in time"), CLOSE_TIMEOUT_MS);
				socket.addEventListener("close", (event: CloseEvent) => {
					clearTimeout(timer);
					if (event.code === NORMAL_CLOSE && event.wasClean) {
						destroy();
						resolve();
					} else {
						fail(describeClose(event));
					}
				});
				socket.close(NORMAL_CLOSE);
				provider.disconnect();
			});
			return closed;
		},
	};
}

const NORMAL_CLOSE = 1000;

function describeClose(event: { code: number; reason: string; wasClean: boolean }): string {
	const reason = event.reason ? `: ${event.reason}` : "";
	return `the connection closed with code ${event.code}${event.wasClean ? "" : " (not clean)"}${reason}`;
}
