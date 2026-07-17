import { execFileSync } from "node:child_process";

export const BOB_VERSION_ENV = "IBM_BOB_VERSION";
export const DEFAULT_BOB_VERSION = "1.0.6";

const VERSION = /^(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const VERSION_IN_OUTPUT = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/;

export type BobVersionDiscovery = () => string | undefined;

function normalizeConfiguredVersion(value: string): string {
	const match = VERSION.exec(value.trim());
	if (!match?.[1]) {
		throw new Error(`${BOB_VERSION_ENV} must be a semantic version such as ${DEFAULT_BOB_VERSION}.`);
	}
	return match[1];
}

export function discoverInstalledBobVersion(): string | undefined {
	try {
		const output = execFileSync("bob", ["--version"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		return VERSION_IN_OUTPUT.exec(output.trim())?.[1];
	} catch {
		return undefined;
	}
}

export function resolveBobVersion(
	environment: NodeJS.ProcessEnv = process.env,
	discover: BobVersionDiscovery = discoverInstalledBobVersion,
): string {
	const configured = environment[BOB_VERSION_ENV];
	if (configured !== undefined) return normalizeConfiguredVersion(configured);
	const installed = discover();
	return installed && VERSION.test(installed) ? normalizeConfiguredVersion(installed) : DEFAULT_BOB_VERSION;
}

export function createBobUserAgent(
	environment: NodeJS.ProcessEnv = process.env,
	discover: BobVersionDiscovery = discoverInstalledBobVersion,
): string {
	return `bobshell/${resolveBobVersion(environment, discover)}`;
}
