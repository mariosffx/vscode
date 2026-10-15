/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Two-way sync of profiles between VS Code and Code - OSS; the most recent change wins.
//
// After every run the synced state is saved, so the next run can tell which side changed what:
// - settings.json is merged per setting: a setting changed on one side is taken from that side,
//   one changed on both sides is taken from the more recently saved file.
// - keybindings, tasks, MCP servers, snippets and prompts: the changed file wins, or the newer
//   one when both changed.
// - extensions: installed or uninstalled on one side means the same on the other.
// - profiles: created in one app means created in the other (that app must be closed). Deleted
//   profiles are only reported, never deleted for you.
// The very first run has nothing to compare with: the newer file wins and extensions are only
// added. Invoked by `mise run sync:profiles`; pass --dry-run to only print what would change.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

/** A profile as stored in `globalStorage/storage.json#userDataProfiles`. */
interface StoredProfile {
	location: string;
	name: string;
	icon?: string;
	useDefaultFlags?: Record<string, boolean>;
}

/** One of the two apps. */
interface Side {
	readonly label: string;
	readonly user: string;
	readonly extensions: string;
	readonly cli: string;
	/** Install folder of the app, or `undefined` when its CLI is not on the PATH. */
	readonly appDir: string | undefined;
	/** Settings only this side has, kept out of the other side and out of the comparison. */
	readonly settingsOverrides: Record<string, unknown>;
	readonly running: boolean;
	readonly builtinExtensions: Set<string>;
	readonly storage: { userDataProfiles?: StoredProfile[] };
	storageChanged: boolean;
}

/** What the previous run left both sides with. */
interface SyncState {
	files: Record<string, string>;
	extensions: Record<string, string[]>;
	profiles: Record<string, Pick<StoredProfile, 'icon' | 'useDefaultFlags'>>;
}

const jsonc: JsoncParser = createRequire(new URL('../../build/package.json', import.meta.url))('jsonc-parser');

const dryRun = process.argv.includes('--dry-run');
const home = os.homedir();
const configHome = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
	: process.platform === 'win32' ? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
		: process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const statePath = path.join(configHome, 'Code - OSS', 'profile-sync-state.json');

/** Files synced as a whole; `settings.json` is merged per setting instead. */
const syncedFiles = ['keybindings.json', 'tasks.json', 'mcp.json'];
const syncedFolders = ['snippets', 'prompts'];
const defaultProfile = 'Default';

function log(message: string): void {
	console.log(dryRun ? `[dry-run] ${message}` : message);
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

function readJson<T>(file: string, fallback: T): T {
	const text = readText(file);
	if (text === undefined) {
		return fallback;
	}
	const errors: { error: number }[] = [];
	const value = jsonc.parse(text, errors, { allowTrailingComma: true });
	if (errors.length) {
		throw new Error(`${file} is not valid JSON`);
	}
	return value ?? fallback;
}

function writeFile(file: string, content: string): void {
	if (!dryRun) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

function mtime(file: string): number {
	return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
}

function hash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function isEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function findAppDir(cli: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		const candidate = path.join(dir, cli);
		if (fs.existsSync(candidate)) {
			return path.resolve(fs.realpathSync(candidate), '..', '..');
		}
	}
	return undefined;
}

/** Whether a process of the app installed in `appDir` is running. Only Linux can tell; elsewhere the app counts as running. */
function isRunning(appDir: string | undefined): boolean {
	if (process.platform !== 'linux') {
		return true;
	}
	if (!appDir) {
		return false;
	}
	for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
		try {
			if (fs.readlinkSync(`/proc/${pid}/exe`).startsWith(appDir + path.sep)) {
				return true;
			}
		} catch {
			// process ended or belongs to another user
		}
	}
	return false;
}

/** Ids of the extensions an app ships with; they are never installed or uninstalled. */
function readBuiltinExtensionIds(appDir: string | undefined): Set<string> {
	const ids = new Set<string>();
	const extensionsDir = appDir && path.join(appDir, 'resources', 'app', 'extensions');
	if (extensionsDir && fs.existsSync(extensionsDir)) {
		for (const name of fs.readdirSync(extensionsDir)) {
			const manifest = readJson<{ publisher?: string; name?: string } | undefined>(path.join(extensionsDir, name, 'package.json'), undefined);
			if (manifest?.publisher && manifest?.name) {
				ids.add(`${manifest.publisher}.${manifest.name}`.toLowerCase());
			}
		}
	}
	return ids;
}

function createSide(label: string, folderName: string, extensionsFolder: string, cli: string, settingsOverrides: Record<string, unknown>): Side {
	const user = path.join(configHome, folderName, 'User');
	const appDir = findAppDir(cli);
	return {
		label,
		user,
		extensions: path.join(home, extensionsFolder, 'extensions'),
		cli,
		appDir,
		settingsOverrides,
		running: isRunning(appDir),
		builtinExtensions: readBuiltinExtensionIds(appDir),
		storage: readJson(path.join(user, 'globalStorage', 'storage.json'), {}),
		storageChanged: false
	};
}

function formattingOptionsFor(text: string): FormattingOptions {
	const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '\t';
	return { insertSpaces: indent[0] === ' ', tabSize: indent[0] === ' ' ? indent.length : 4, eol: '\n' };
}

function setSettings(text: string, values: Record<string, unknown>): string {
	const formattingOptions = formattingOptionsFor(text);
	for (const [key, value] of Object.entries(values)) {
		text = jsonc.applyEdits(text, jsonc.modify(text, [key], value, { formattingOptions }));
	}
	return text;
}

/** The settings both sides share: the side's own overrides removed. */
function sharedSettingsText(side: Side, text: string): string {
	return setSettings(text, Object.fromEntries(Object.keys(side.settingsOverrides).map(key => [key, undefined])));
}

function profileDir(side: Side, profile: StoredProfile | undefined): string {
	return profile ? path.join(side.user, 'profiles', profile.location) : side.user;
}

function extensionsList(side: Side, profile: StoredProfile | undefined): string {
	return profile ? path.join(profileDir(side, profile), 'extensions.json') : path.join(side.extensions, 'extensions.json');
}

function readExtensionIds(file: string): Set<string> {
	return new Set(readJson<{ identifier: { id: string } }[]>(file, []).map(extension => extension.identifier.id.toLowerCase()));
}

function newer(a: string, b: string): 'a' | 'b' {
	return mtime(a) >= mtime(b) ? 'a' : 'b';
}

/** Merges `settings.json` per setting and writes the result to whichever side needs it. */
function syncSettings(name: string, a: Side, aDir: string, b: Side, bDir: string, state: SyncState, nextState: SyncState): void {
	const aFile = path.join(aDir, 'settings.json');
	const bFile = path.join(bDir, 'settings.json');
	const aRaw = readText(aFile);
	const bRaw = readText(bFile);
	if (aRaw === undefined && bRaw === undefined) {
		return;
	}
	const aText = sharedSettingsText(a, aRaw ?? '{}');
	const bText = sharedSettingsText(b, bRaw ?? '{}');
	const aValues: Record<string, unknown> = jsonc.parse(aText) ?? {};
	const bValues: Record<string, unknown> = jsonc.parse(bText) ?? {};
	const key = `${name}/settings.json`;
	const base: Record<string, unknown> | undefined = state.files[key] === undefined ? undefined : jsonc.parse(state.files[key]) ?? {};
	const winner = aRaw === undefined ? 'b' : bRaw === undefined ? 'a' : newer(aFile, bFile);

	let merged = winner === 'a' ? aText : bText;
	const changes: string[] = [];
	for (const setting of new Set([...Object.keys(aValues), ...Object.keys(bValues)])) {
		const aValue = aValues[setting];
		const bValue = bValues[setting];
		if (isEqual(aValue, bValue)) {
			continue;
		}
		let value: unknown;
		let from: Side;
		if (base && isEqual(aValue, base[setting])) {
			value = bValue;
			from = b;
		} else if (base && isEqual(bValue, base[setting])) {
			value = aValue;
			from = a;
		} else {
			value = winner === 'a' ? aValue : bValue;
			from = winner === 'a' ? a : b;
		}
		changes.push(`${setting} (from ${from.label})`);
		merged = setSettings(merged, { [setting]: value });
	}

	const aResult = setSettings(merged, a.settingsOverrides);
	const bResult = setSettings(merged, b.settingsOverrides);
	if (changes.length) {
		log(`${name}: settings.json: ${changes.join(', ')}`);
	}
	if (aResult !== aRaw) {
		writeFile(aFile, aResult);
	}
	if (bResult !== bRaw) {
		writeFile(bFile, bResult);
	}
	nextState.files[key] = merged;
}

/** Syncs a file as a whole: the side that changed it wins, or the newer file when both did. */
function syncWholeFile(name: string, relative: string, a: Side, aDir: string, b: Side, bDir: string, state: SyncState, nextState: SyncState): void {
	const aFile = path.join(aDir, relative);
	const bFile = path.join(bDir, relative);
	const aText = readText(aFile);
	const bText = readText(bFile);
	const key = `${name}/${relative}`;
	if (aText === bText) {
		if (aText !== undefined) {
			nextState.files[key] = hash(aText);
		}
		return;
	}
	const base = state.files[key];
	let winner: 'a' | 'b';
	if (aText === undefined) {
		winner = 'b';
	} else if (bText === undefined) {
		winner = 'a';
	} else if (base !== undefined && hash(aText) === base) {
		winner = 'b';
	} else if (base !== undefined && hash(bText) === base) {
		winner = 'a';
	} else {
		winner = newer(aFile, bFile);
	}
	const [from, to, text, target]: [Side, Side, string, string] = winner === 'a' ? [a, b, aText!, bFile] : [b, a, bText!, aFile];
	log(`${name}: ${relative} ${from.label} -> ${to.label}`);
	writeFile(target, text);
	nextState.files[key] = hash(text);
}

function listFolder(dir: string): string[] {
	return fs.existsSync(dir)
		? fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => fs.statSync(path.join(dir, file)).isFile())
		: [];
}

function runCli(side: Side, profile: string | undefined, flag: string, ids: string[]): boolean {
	const args = [...(profile ? ['--profile', profile] : []), ...ids.flatMap(id => [flag, id])];
	return spawnSync(side.cli, args, { stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
}

/** Applies extension installs and uninstalls made on either side since the last run. */
function syncExtensions(name: string, a: Side, aProfile: StoredProfile | undefined, b: Side, bProfile: StoredProfile | undefined, state: SyncState, nextState: SyncState): boolean {
	// built-in extensions count as installed: they never show up in the extension lists
	const has = (side: Side, ids: Set<string>, id: string) => ids.has(id) || side.builtinExtensions.has(id);
	const aIds = readExtensionIds(extensionsList(a, aProfile));
	const bIds = readExtensionIds(extensionsList(b, bProfile));
	const base = state.extensions[name] ? new Set(state.extensions[name]) : undefined;
	const wanted = new Set<string>();
	for (const id of new Set([...aIds, ...bIds])) {
		// on the first run nothing counts as uninstalled
		const uninstalled = base?.has(id) && (!has(a, aIds, id) || !has(b, bIds, id));
		if (!uninstalled) {
			wanted.add(id);
		}
	}

	let ok = true;
	for (const [side, ids, profile] of [[a, aIds, aProfile], [b, bIds, bProfile]] as const) {
		const install = [...wanted].filter(id => !ids.has(id) && !side.builtinExtensions.has(id));
		const uninstall = [...ids].filter(id => !wanted.has(id));
		const profileName = profile ? name : undefined;
		if (install.length) {
			log(`${name}: install in ${side.label}: ${install.join(', ')}`);
			ok = (dryRun || runCli(side, profileName, '--install-extension', install)) && ok;
		}
		if (uninstall.length) {
			log(`${name}: uninstall from ${side.label}: ${uninstall.join(', ')}`);
			ok = (dryRun || runCli(side, profileName, '--uninstall-extension', uninstall)) && ok;
		}
	}

	// What both sides ended up with. A failed install stays out of it and a failed uninstall stays
	// in it, so the next run retries them instead of undoing them on the other side.
	const aAfter = readExtensionIds(extensionsList(a, aProfile));
	const bAfter = readExtensionIds(extensionsList(b, bProfile));
	nextState.extensions[name] = dryRun ? state.extensions[name] ?? [] : [...new Set([...aAfter, ...bAfter])]
		.filter(id => (has(a, aAfter, id) && has(b, bAfter, id)) || !wanted.has(id))
		.sort();
	return ok;
}

function backup(sides: Side[]): void {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupDir = path.join(path.dirname(statePath), 'profile-sync-backups', stamp);
	for (const side of sides) {
		fs.cpSync(side.user, path.join(backupDir, side.label, 'User'), {
			recursive: true,
			filter: from => {
				const parts = path.relative(side.user, from).split(path.sep);
				if (parts[0] === 'History' || parts[0] === 'workspaceStorage') {
					return false;
				}
				// of all the per-app state only the profile list is needed
				const index = parts.indexOf('globalStorage');
				return index === -1 || parts.length === index + 1 || (index === 0 && parts[1] === 'storage.json');
			}
		});
		const list = path.join(side.extensions, 'extensions.json');
		if (fs.existsSync(list)) {
			fs.copyFileSync(list, path.join(backupDir, side.label, 'extensions.json'));
		}
	}
	console.log(`==> backed up both apps' settings to ${backupDir}`);
}

/** Finds or creates the profile `name` on `side`; `undefined` when it can't be created because the app is running. */
function ensureProfile(side: Side, from: StoredProfile): StoredProfile | undefined {
	const profiles = side.storage.userDataProfiles ??= [];
	const existing = profiles.find(profile => profile.name === from.name);
	if (existing) {
		return existing;
	}
	if (side.running) {
		console.warn(`warning: ${from.name}: can't create it in ${side.label} while ${side.label} is open; close it and run this again`);
		return undefined;
	}
	let location = from.location;
	while (profiles.some(profile => profile.location === location)) {
		location = randomBytes(4).toString('hex');
	}
	const created: StoredProfile = { location, name: from.name, icon: from.icon, useDefaultFlags: from.useDefaultFlags };
	profiles.push(created);
	side.storageChanged = true;
	log(`${from.name}: new profile in ${side.label}`);
	return created;
}

/** Syncs icon and shared-with-default flags; the side that changed them wins. */
function syncProfileDetails(a: Side, aProfile: StoredProfile, b: Side, bProfile: StoredProfile, state: SyncState, nextState: SyncState): void {
	const details = (profile: StoredProfile) => ({ icon: profile.icon, useDefaultFlags: profile.useDefaultFlags });
	const aDetails = details(aProfile);
	const bDetails = details(bProfile);
	const base = state.profiles[aProfile.name];
	if (!isEqual(aDetails, bDetails)) {
		const takeB = base !== undefined && isEqual(aDetails, base);
		const [from, fromProfile, to, toProfile]: [Side, StoredProfile, Side, StoredProfile] = takeB ? [b, bProfile, a, aProfile] : [a, aProfile, b, bProfile];
		if (to.running) {
			console.warn(`warning: ${aProfile.name}: icon or shared settings differ; close ${to.label} and run this again to update them`);
		} else {
			log(`${aProfile.name}: profile icon and shared settings ${from.label} -> ${to.label}`);
			toProfile.icon = fromProfile.icon;
			toProfile.useDefaultFlags = fromProfile.useDefaultFlags;
			to.storageChanged = true;
		}
	}
	nextState.profiles[aProfile.name] = details(aProfile);
}

function main(): void {
	const vscode = createSide('VS Code', 'Code', '.vscode', process.env.VSCODE_CLI || 'code', {});
	// Marketplace extensions can't be signature-checked in Code - OSS (the checker isn't open
	// source); the setting only takes effect in the default profile.
	const oss = createSide('Code - OSS', 'Code - OSS', '.vscode-oss', process.env.CODE_OSS_CLI || 'code-oss', { 'extensions.verifySignature': false });
	for (const side of [vscode, oss]) {
		if (!fs.existsSync(side.user)) {
			throw new Error(`no ${side.label} user data at ${side.user}`);
		}
	}
	const state = readJson<SyncState>(statePath, { files: {}, extensions: {}, profiles: {} });
	const nextState: SyncState = { files: {}, extensions: {}, profiles: {} };
	if (!dryRun) {
		backup([vscode, oss]);
	}

	// 1. Profile list. System profiles (builtin/...) are created by each app itself.
	const userProfiles = (side: Side) => (side.storage.userDataProfiles ?? []).filter(profile => !profile.location.startsWith('builtin/'));
	const pairs: { name: string; a: StoredProfile | undefined; b: StoredProfile | undefined }[] = [{ name: defaultProfile, a: undefined, b: undefined }];
	for (const name of new Set([...userProfiles(vscode), ...userProfiles(oss)].map(profile => profile.name))) {
		const inA = userProfiles(vscode).find(profile => profile.name === name);
		const inB = userProfiles(oss).find(profile => profile.name === name);
		if ((!inA || !inB) && state.profiles[name]) {
			console.warn(`warning: ${name}: deleted in ${inA ? oss.label : vscode.label}; delete it in ${inA ? vscode.label : oss.label} too, or recreate it`);
			nextState.profiles[name] = state.profiles[name];
			continue;
		}
		const a = inA ?? ensureProfile(vscode, inB!);
		const b = inB ?? ensureProfile(oss, inA!);
		if (a && b) {
			syncProfileDetails(vscode, a, oss, b, state, nextState);
			pairs.push({ name, a, b });
		}
	}
	for (const side of [vscode, oss]) {
		if (side.storageChanged) {
			writeFile(path.join(side.user, 'globalStorage', 'storage.json'), JSON.stringify(side.storage, null, 4));
		}
	}

	// 2. Settings files, then 3. extensions, which the CLIs install into the profiles created above.
	let ok = true;
	for (const { name, a, b } of pairs) {
		const aDir = profileDir(vscode, a);
		const bDir = profileDir(oss, b);
		syncSettings(name, vscode, aDir, oss, bDir, state, nextState);
		for (const relative of new Set([...syncedFiles, ...syncedFolders.flatMap(folder => [...listFolder(path.join(aDir, folder)), ...listFolder(path.join(bDir, folder))].map(file => path.join(folder, file)))])) {
			syncWholeFile(name, relative, vscode, aDir, oss, bDir, state, nextState);
		}
		if (!a?.useDefaultFlags?.extensions) {
			ok = syncExtensions(name, vscode, a, oss, b, state, nextState) && ok;
		}
	}

	if (!dryRun) {
		writeFile(statePath, JSON.stringify(nextState, null, '\t'));
	}
	if (!ok) {
		throw new Error('some extensions failed to install or uninstall; run this again to retry');
	}
	console.log(`==> ${dryRun ? 'dry run finished, nothing changed' : `synced ${pairs.length - 1} profiles and the default profile`}`);
}

try {
	main();
} catch (error) {
	console.error(`error: ${(error as Error).message}`);
	process.exit(1);
}
