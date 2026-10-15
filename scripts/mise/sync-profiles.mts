/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copies every VS Code profile into Code - OSS: the profile list (names, icons, what each
// profile shares with the default one), the settings files and each profile's extensions.
// VS Code wins where both have a value; settings that only Code - OSS has are kept and nothing
// is uninstalled. Code - OSS must be closed. Invoked by `mise run sync:profiles`; pass
// --dry-run to only print what would change.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

/** The parts of `jsonc-parser` used here; it is a dependency of the build folder. */
interface JsoncParser {
	parse(text: string, errors?: { error: number }[], options?: { allowTrailingComma?: boolean }): any;
	modify(text: string, path: string[], value: unknown, options: { formattingOptions: FormattingOptions }): Edit[];
	applyEdits(text: string, edits: Edit[]): string;
}
interface FormattingOptions {
	insertSpaces: boolean;
	tabSize: number;
	eol: string;
}
interface Edit {
	offset: number;
	length: number;
	content: string;
}

const jsonc: JsoncParser = createRequire(new URL('../../build/package.json', import.meta.url))('jsonc-parser');

/** A profile as stored in `globalStorage/storage.json#userDataProfiles`. */
interface StoredProfile {
	location: string;
	name: string;
	icon?: string;
	useDefaultFlags?: Record<string, boolean>;
}

/** A VS Code profile and the Code - OSS profile it is copied into. */
interface ProfilePair {
	/** `undefined` for the default profile. */
	readonly name: string | undefined;
	readonly label: string;
	readonly sourceDir: string;
	readonly targetDir: string;
	/** `undefined` when the profile shares the default profile's extensions. */
	readonly sourceExtensions: string | undefined;
	readonly targetExtensions: string;
}

const dryRun = process.argv.includes('--dry-run');
const home = os.homedir();
const configHome = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
	: process.platform === 'win32' ? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
		: process.env.XDG_CONFIG_HOME || path.join(home, '.config');

const source = { user: path.join(configHome, 'Code', 'User'), extensions: path.join(home, '.vscode', 'extensions') };
const target = { user: path.join(configHome, 'Code - OSS', 'User'), extensions: path.join(home, '.vscode-oss', 'extensions') };
const cli = process.env.CODE_OSS_CLI || 'code-oss';

/** Files copied as they are; `settings.json` is merged instead. Per-app state (globalStorage, chat models, extension lists) is never copied. */
const copiedFiles = ['keybindings.json', 'tasks.json', 'mcp.json'];
const copiedFolders = ['snippets', 'prompts'];

function log(message: string): void {
	console.log(dryRun ? `[dry-run] ${message}` : message);
}

function readJson<T>(file: string, fallback: T): T {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return fallback;
		}
		throw error;
	}
	const errors: { error: number }[] = [];
	const value = jsonc.parse(text, errors, { allowTrailingComma: true });
	if (errors.length) {
		throw new Error(`${file} is not valid JSON`);
	}
	return value ?? fallback;
}

function writeFile(file: string, content: string | Buffer): void {
	if (!dryRun) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

function isSameFile(a: string, b: string): boolean {
	return fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Lists Code - OSS processes that share the user data folder. Dev builds (`.build/electron`)
 * use their own `code-oss-dev` folder, so they don't count.
 */
function findRunningCodeOss(): string[] {
	if (process.platform !== 'linux') {
		return [];
	}
	const running: string[] = [];
	for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
		let exe: string;
		try {
			exe = fs.readlinkSync(`/proc/${pid}/exe`);
		} catch {
			continue;
		}
		if (path.basename(exe) === 'code-oss' && !exe.includes(`${path.sep}.build${path.sep}electron${path.sep}`)) {
			running.push(pid);
		}
	}
	return running;
}

/** Ids of the extensions Code - OSS ships with; installing a Marketplace copy over them would replace the built-in one. */
function readBuiltinExtensionIds(): Set<string> {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		const candidate = path.join(dir, cli);
		if (!fs.existsSync(candidate)) {
			continue;
		}
		const extensionsDir = path.resolve(fs.realpathSync(candidate), '..', '..', 'resources', 'app', 'extensions');
		if (!fs.existsSync(extensionsDir)) {
			break;
		}
		const ids = new Set<string>();
		for (const name of fs.readdirSync(extensionsDir)) {
			const manifest = readJson<{ publisher?: string; name?: string } | undefined>(path.join(extensionsDir, name, 'package.json'), undefined);
			if (manifest?.publisher && manifest?.name) {
				ids.add(`${manifest.publisher}.${manifest.name}`.toLowerCase());
			}
		}
		return ids;
	}
	console.warn(`warning: could not find the ${cli} install; built-in extensions are not skipped`);
	return new Set();
}

function readExtensionIds(file: string): Set<string> {
	return new Set(readJson<{ identifier: { id: string } }[]>(file, []).map(extension => extension.identifier.id.toLowerCase()));
}

/** VS Code's settings with the keys only Code - OSS has added back, formatted like the source file. */
function mergeSettings(sourceText: string, targetText: string, overrides: Record<string, unknown>): string {
	const indent = /^([ \t]+)"/m.exec(sourceText)?.[1] ?? '\t';
	const formattingOptions: FormattingOptions = { insertSpaces: indent[0] === ' ', tabSize: indent[0] === ' ' ? indent.length : 4, eol: '\n' };
	const sourceSettings: Record<string, unknown> = jsonc.parse(sourceText) ?? {};
	const targetSettings: Record<string, unknown> = jsonc.parse(targetText) ?? {};
	const additions = { ...Object.fromEntries(Object.entries(targetSettings).filter(([key]) => !Object.hasOwn(sourceSettings, key))), ...overrides };
	let text = sourceText;
	for (const [key, value] of Object.entries(additions)) {
		text = jsonc.applyEdits(text, jsonc.modify(text, [key], value, { formattingOptions }));
	}
	return text;
}

function syncFiles(sourceDir: string, targetDir: string, label: string, settingsOverrides: Record<string, unknown>): void {
	const sourceSettings = path.join(sourceDir, 'settings.json');
	if (fs.existsSync(sourceSettings)) {
		const targetSettings = path.join(targetDir, 'settings.json');
		const current = fs.existsSync(targetSettings) ? fs.readFileSync(targetSettings, 'utf8') : '{}';
		const merged = mergeSettings(fs.readFileSync(sourceSettings, 'utf8'), current, settingsOverrides);
		if (merged !== current) {
			log(`${label}: settings.json`);
			writeFile(targetSettings, merged);
		}
	}
	for (const name of copiedFiles) {
		const from = path.join(sourceDir, name);
		const to = path.join(targetDir, name);
		if (fs.existsSync(from) && !isSameFile(from, to)) {
			log(`${label}: ${name}`);
			writeFile(to, fs.readFileSync(from));
		}
	}
	for (const name of copiedFolders) {
		const from = path.join(sourceDir, name);
		const to = path.join(targetDir, name);
		const changed = fs.existsSync(from) && fs.readdirSync(from, { recursive: true, encoding: 'utf8' })
			.filter(file => fs.statSync(path.join(from, file)).isFile())
			.some(file => !isSameFile(path.join(from, file), path.join(to, file)));
		if (changed) {
			log(`${label}: ${name}/`);
			if (!dryRun) {
				fs.cpSync(from, to, { recursive: true, force: true });
			}
		}
	}
}

function backup(): void {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupDir = path.join(path.dirname(target.user), 'profile-sync-backups', stamp);
	const skipped = new Set(['History', 'workspaceStorage']);
	fs.cpSync(target.user, path.join(backupDir, 'User'), {
		recursive: true,
		filter: from => !skipped.has(path.relative(target.user, from).split(path.sep)[0])
	});
	const extensionsList = path.join(target.extensions, 'extensions.json');
	if (fs.existsSync(extensionsList)) {
		fs.copyFileSync(extensionsList, path.join(backupDir, 'extensions.json'));
	}
	console.log(`==> backed up Code - OSS user data to ${backupDir}`);
}

function main(): void {
	if (!fs.existsSync(source.user)) {
		throw new Error(`no VS Code user data at ${source.user}`);
	}
	const running = findRunningCodeOss();
	if (running.length) {
		throw new Error(`Code - OSS is running (pid ${running.join(', ')}); quit every window and run this again`);
	}
	if (process.platform !== 'linux') {
		console.warn('warning: make sure Code - OSS is closed; it overwrites the profile list on exit');
	}
	if (!dryRun && fs.existsSync(target.user)) {
		backup();
	}

	// 1. Profile list. System profiles (builtin/...) are created by each app itself.
	const sourceStorage = readJson<{ userDataProfiles?: StoredProfile[] }>(path.join(source.user, 'globalStorage', 'storage.json'), {});
	const targetStoragePath = path.join(target.user, 'globalStorage', 'storage.json');
	const targetStorage = readJson<{ userDataProfiles?: StoredProfile[] }>(targetStoragePath, {});
	const targetProfiles = targetStorage.userDataProfiles ?? [];
	const pairs: ProfilePair[] = [{
		name: undefined,
		label: 'Default',
		sourceDir: source.user,
		targetDir: target.user,
		sourceExtensions: path.join(source.extensions, 'extensions.json'),
		targetExtensions: path.join(target.extensions, 'extensions.json')
	}];
	for (const profile of sourceStorage.userDataProfiles ?? []) {
		if (profile.location.startsWith('builtin/')) {
			continue;
		}
		let existing = targetProfiles.find(candidate => candidate.name === profile.name);
		if (!existing) {
			let location = profile.location;
			while (targetProfiles.some(candidate => candidate.location === location)) {
				location = randomBytes(4).toString('hex');
			}
			existing = { location, name: profile.name };
			targetProfiles.push(existing);
			log(`${profile.name}: new profile`);
		}
		existing.icon = profile.icon;
		existing.useDefaultFlags = profile.useDefaultFlags;
		const sourceDir = path.join(source.user, 'profiles', profile.location);
		const targetDir = path.join(target.user, 'profiles', existing.location);
		pairs.push({
			name: profile.name,
			label: profile.name,
			sourceDir,
			targetDir,
			sourceExtensions: profile.useDefaultFlags?.extensions ? undefined : path.join(sourceDir, 'extensions.json'),
			targetExtensions: path.join(targetDir, 'extensions.json')
		});
	}
	targetStorage.userDataProfiles = targetProfiles;
	writeFile(targetStoragePath, JSON.stringify(targetStorage, null, 4));

	// 2. Settings files. Marketplace extensions can't be signature-checked in Code - OSS (the
	// checker isn't open source), and the setting only takes effect in the default profile.
	for (const pair of pairs) {
		if (!dryRun) {
			fs.mkdirSync(pair.targetDir, { recursive: true });
		}
		syncFiles(pair.sourceDir, pair.targetDir, pair.label, pair.name === undefined ? { 'extensions.verifySignature': false } : {});
	}

	// 3. Extensions, after the profile list and settings above are on disk for the CLI to read.
	const builtin = readBuiltinExtensionIds();
	const failed: string[] = [];
	for (const pair of pairs) {
		if (!pair.sourceExtensions) {
			continue;
		}
		const installed = readExtensionIds(pair.targetExtensions);
		const missing = [...readExtensionIds(pair.sourceExtensions)].filter(id => !installed.has(id) && !builtin.has(id));
		if (!missing.length) {
			continue;
		}
		log(`${pair.label}: installing ${missing.join(', ')}`);
		if (dryRun) {
			continue;
		}
		const args = [...(pair.name ? ['--profile', pair.name] : []), ...missing.flatMap(id => ['--install-extension', id])];
		const result = spawnSync(cli, args, { stdio: 'inherit', shell: process.platform === 'win32' });
		if (result.status !== 0) {
			failed.push(pair.label);
		}
	}

	if (failed.length) {
		throw new Error(`some extensions failed to install in: ${failed.join(', ')}`);
	}
	console.log(`==> ${dryRun ? 'dry run finished, nothing changed' : `synced ${pairs.length - 1} profiles and the default profile`}`);
	console.log('    Extensions that need proposed APIs also need an entry in product.json#extensionEnabledApiProposals.');
}

try {
	main();
} catch (error) {
	console.error(`error: ${(error as Error).message}`);
	process.exit(1);
}
