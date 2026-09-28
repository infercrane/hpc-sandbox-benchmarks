import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox } from "@infercrane/brezel";
import { BrezelClient, BrezelError } from "@infercrane/brezel";
import type { DriverContext, ExecOptions } from "@sandbox-benchmarks/driver";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import { BREZEL_PROVENANCE } from "./provenance.ts";

export const BREZEL_SANDBOX_ID = type(/^sbx_[A-Za-z0-9_-]+$/);
const TERMINAL_STATES = new Set(["deleted", "expired", "failed"]);
// The qualified Brezel benchmark project caps a single allocation at two hours. The longest
// Starsling task is routed through shell-detach and remains below this allocation boundary.
const CREATE_TTL_SECONDS = 2 * 60 * 60;
const CONTROL_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 3 * 60_000;
const DELETE_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

const sandboxResource = type({
	id: BREZEL_SANDBOX_ID,
	state:
		"'requested' | 'preparing' | 'running' | 'pausing' | 'standby' | 'resuming' | 'deleting' | 'deleted' | 'expired' | 'failed' | 'unknown'",
	environment_revision: "string >= 1",
}).onUndeclaredKey("ignore");
const createResponse = type({ resource: sandboxResource }).onUndeclaredKey("ignore");
const optionsSchema = type({
	idempotencyKey: "string >= 1",
	environmentRevision: "string >= 1",
});

interface BrezelCreateBody {
	readonly environment_revision: string;
	readonly lifecycle: { readonly expires_after_seconds: number };
	readonly network: { readonly allow_internet: true };
}

export interface BrezelSpecOptions {
	readonly client?: BrezelClient;
	readonly pollMs?: number;
	readonly readyTimeoutMs?: number;
	readonly deleteTimeoutMs?: number;
}

function createBody(environmentRevision: string): BrezelCreateBody {
	return {
		environment_revision: environmentRevision,
		lifecycle: { expires_after_seconds: CREATE_TTL_SECONDS },
		network: { allow_internet: true },
	};
}

function isNotFound(error: unknown): boolean {
	return matchesAnyCause(error, (cause) => cause instanceof BrezelError && cause.status === 404);
}

function isDefinitiveCreateRejection(error: unknown): boolean {
	return matchesAnyCause(
		error,
		// Brezel checks project quota and node capacity before it calls the backend, so 429 proves
		// that this attempt allocated nothing while still remaining eligible for a harness retry.
		(cause) => cause instanceof BrezelError && [400, 401, 403, 404, 429].includes(cause.status),
	);
}

function isRetryableCreateRejection(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) => cause instanceof BrezelError && [429, 502, 503, 504].includes(cause.status),
	);
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	await delay(ms, undefined, signal === undefined ? undefined : { signal });
}

async function getResource(client: BrezelClient, id: string) {
	return sandboxResource.assert(await client.requestJSON("GET", `/v1/sandboxes/${id}`));
}

async function waitForRunning(
	client: BrezelClient,
	id: string,
	options: { readonly signal?: AbortSignal; readonly pollMs: number; readonly timeoutMs: number },
) {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		options.signal?.throwIfAborted();
		const resource = await getResource(client, id);
		if (resource.state === "running") return resource;
		if (TERMINAL_STATES.has(resource.state)) {
			throw new Error(`Brezel sandbox entered terminal state ${resource.state} before readiness`);
		}
		if (Date.now() >= deadline) throw new Error("Brezel sandbox did not become ready in time");
		await sleep(options.pollMs, options.signal);
	}
}

async function destroyAndConverge(
	client: BrezelClient,
	id: string,
	options: {
		readonly signal?: AbortSignal;
		readonly pollMs: number;
		readonly timeoutMs: number;
	},
): Promise<void> {
	options.signal?.throwIfAborted();
	try {
		const current = await getResource(client, id);
		if (TERMINAL_STATES.has(current.state)) return;
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	await client.requestJSON("DELETE", `/v1/sandboxes/${id}`, {
		idempotencyKey: `benchmark-delete-${id}`,
	});
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		options.signal?.throwIfAborted();
		try {
			const resource = await getResource(client, id);
			if (TERMINAL_STATES.has(resource.state)) return;
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
		if (Date.now() >= deadline) throw new Error("Brezel sandbox deletion did not converge");
		await sleep(options.pollMs, options.signal);
	}
}

async function exec(native: Sandbox, command: string, options?: ExecOptions) {
	options?.signal?.throwIfAborted();
	const result = await native.run(["/bin/sh", "-lc", command], { timeoutSeconds: 60 });
	options?.signal?.throwIfAborted();
	return {
		exitCode: result.exitCode,
		stdout: result.stdoutText,
		stderr: result.stderrText,
	};
}

export function brezelSpec(
	{ env, resolvedArtifact }: DriverContext<"brezel">,
	seams: BrezelSpecOptions = {},
) {
	const client =
		seams.client ??
		new BrezelClient({
			token: env.BREZEL_API_KEY,
			baseUrl: env.BREZEL_API_URL,
			project: env.BREZEL_PROJECT_ID,
			timeoutMs: CONTROL_TIMEOUT_MS,
		});
	const pollMs = seams.pollMs ?? POLL_MS;
	const readyTimeoutMs = seams.readyTimeoutMs ?? READY_TIMEOUT_MS;
	const deleteTimeoutMs = seams.deleteTimeoutMs ?? DELETE_TIMEOUT_MS;
	const environmentRevision = env.BREZEL_ENVIRONMENT_REVISION;
	const body = createBody(environmentRevision);

	const compute = nativeSdkCompute(
		async (options: typeof optionsSchema.infer, operation) => {
			operation.signal?.throwIfAborted();
			const payload = createResponse.assert(
				await client.requestJSON("POST", "/v1/sandboxes", {
					body,
					idempotencyKey: options.idempotencyKey,
				}),
			);
			operation.signal?.throwIfAborted();
			return client.sandbox(payload.resource.id);
		},
		(native) => ({
			sandboxId: native.id,
			runCommand: (command: string, options?: ExecOptions) => exec(native, command, options),
			destroy: () =>
				destroyAndConverge(client, native.id, {
					pollMs,
					timeoutMs: deleteTimeoutMs,
				}),
			filesystem: {
				readFile: async (path: string) => new TextDecoder().decode(await native.readFile(path)),
				exists: async (path: string) =>
					(await exec(native, `test -e -- ${quoteShell(path)}`)).exitCode === 0,
				writeFile: async (path: string, content: string) => {
					await native.writeFile(path, content);
				},
			},
		}),
	);

	return computeSdkSpec(compute, {
		sandboxId: BREZEL_SANDBOX_ID,
		createOptions: {
			coverage: {
				spec: { vcpus: { artifact: 4 }, memoryGb: { artifact: 8 }, diskGb: "runtime-verified" },
				artifact: "context",
				deadlineMs: "harness",
				gpu: { model: "unsupported", count: "unsupported" },
				env: "unsupported",
			},
			map: (request, unsupported) => {
				if (request.artifact.kind !== "none" || resolvedArtifact.kind !== "none") {
					unsupported("Brezel uses the manually pinned environment revision from driver context");
				}
				return {
					idempotencyKey: `benchmark-${randomUUID()}`,
					environmentRevision,
				};
			},
		},
		lifecycle: {
			destroy: async (sandbox, ref, operation) =>
				destroyAndConverge(client, ref?.id ?? sandbox.sandboxId ?? sandbox.getInstance().id, {
					signal: operation.signal,
					pollMs,
					timeoutMs: deleteTimeoutMs,
				}),
		},
		createRecovery: {
			absenceConfirmationMs: 1000,
			maxAttempts: 3,
			locator: (options) => ({
				kind: "marker",
				key: "Idempotency-Key",
				value: options.idempotencyKey,
			}),
			isDefinitive: isDefinitiveCreateRejection,
			isRetryableCreate: isRetryableCreateRejection,
			cleanup: async (_compute, locator, operation) => {
				operation.signal?.throwIfAborted();
				const payload = createResponse.assert(
					await client.requestJSON("POST", "/v1/sandboxes", {
						body,
						idempotencyKey: locator.value,
					}),
				);
				await destroyAndConverge(client, payload.resource.id, {
					signal: operation.signal,
					pollMs,
					timeoutMs: deleteTimeoutMs,
				});
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: async (_sandbox, native, request, operation) => {
			const resource = await waitForRunning(client, native.id, {
				signal: operation.signal,
				pollMs,
				timeoutMs: readyTimeoutMs,
			});
			if (resource.environment_revision !== environmentRevision) {
				throw new Error("Brezel created a sandbox from a different environment revision");
			}
			if (request.spec.diskGb === undefined) return { status: "honored" };
			const result = await exec(native, "df -Pk / | awk 'NR==2 {print $2}'", operation);
			if (result.exitCode !== 0 || !/^\d+$/.test(result.stdout.trim())) {
				throw new Error("Brezel disk capacity probe failed");
			}
			const capacity = Number(result.stdout.trim()) / 1024 / 1024;
			return capacity >= request.spec.diskGb
				? { status: "honored" }
				: {
						status: "unsupported",
						detail: `requested ${request.spec.diskGb} GiB but allocation exposes ${capacity.toFixed(2)} GiB`,
					};
		},
		hasWorkingFilesystem: true,
		probes: {
			observe: async (_compute, ref) => {
				try {
					const resource = await getResource(client, ref.id);
					if (resource.state === "running") return { state: "running" };
					if (TERMINAL_STATES.has(resource.state)) return { state: "absent" };
					return { state: "terminal", detail: `Brezel sandbox is ${resource.state}` };
				} catch (error) {
					if (isNotFound(error)) return { state: "absent" };
					throw error;
				}
			},
			describe: (_compute, ref) => client.requestJSON("GET", `/v1/sandboxes/${ref.id}`),
			list: () => client.listSandboxes(),
		},
		inventory: {
			list: async (_compute, operation) => {
				operation.signal?.throwIfAborted();
				const rows = await client.listSandboxes();
				operation.signal?.throwIfAborted();
				return {
					owned: rows.map((row) => sandboxResource.assert(row).id),
					foreignCount: 0,
				};
			},
		},
		destroyById: async (_compute, ref, operation) =>
			destroyAndConverge(client, ref.id, {
				signal: operation.signal,
				pollMs,
				timeoutMs: deleteTimeoutMs,
			}),
	});
}

export default defineComputeSdkDriver("brezel", {
	provenance: BREZEL_PROVENANCE,
	readiness: { startup: "create-returns-ready" },
	execution: { syncCapMs: 60_000, durable: "shell-detach" },
	spec: brezelSpec,
});
