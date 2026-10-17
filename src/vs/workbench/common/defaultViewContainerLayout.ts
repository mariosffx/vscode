/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ViewContainerLocation } from './views.js';

/**
 * Where a view container contributed by an extension starts, until the user moves it.
 */
export interface IDefaultViewContainerPlacement {
	readonly location: ViewContainerLocation;
	readonly order: number;
}

/**
 * Extension view containers that start in another location than the one they are contributed
 * to, or at another position there. Without an order they keep the one of their contribution.
 */
const DEFAULT_VIEW_CONTAINER_PLACEMENTS: ReadonlyMap<string, { readonly location?: ViewContainerLocation; readonly order?: number }> = new Map([
	// Claude Code usage, first in the bottom half of the Primary Side Bar, above Run and Debug (order 3)
	['workbench.view.extension.claude-sessions-sidebar', { order: 2.5 }],
	// Claude Code chat sessions, first in the bottom half of the Secondary Side Bar, above GitHub Pull Request (order 3)
	['workbench.view.extension.claude-sidebar-secondary', { order: 2.5 }],
	// GitHub, from GitHub Pull Requests, below Source Control
	['workbench.view.extension.github-pull-requests', { location: ViewContainerLocation.AuxiliaryBar }],
	// GitHub Pull Request, in the bottom half above Extensions (order 4)
	['workbench.view.extension.github-pull-request', { location: ViewContainerLocation.AuxiliaryBar, order: 3 }],
	// Containers, from Container Tools, in the bottom half right above Extensions
	['workbench.view.extension.containersView', { location: ViewContainerLocation.AuxiliaryBar, order: 3.5 }],
]);

/**
 * Returns where an extension's view container starts, given the location it is contributed to
 * and the order it would take there.
 */
export function getDefaultViewContainerPlacement(viewContainerId: string, location: ViewContainerLocation, order: number): IDefaultViewContainerPlacement {
	const placement = DEFAULT_VIEW_CONTAINER_PLACEMENTS.get(viewContainerId);
	return { location: placement?.location ?? location, order: placement?.order ?? order };
}

/**
 * View containers that start in the bottom half of the Primary Side Bar, until the user moves
 * any. The bottom icon group of its rail shows them above Accounts.
 */
export const DEFAULT_SIDEBAR_BOTTOM_VIEW_CONTAINERS: readonly string[] = [
	'workbench.view.extension.claude-sessions-sidebar', // Claude Code usage
	'workbench.view.debug', // Run and Debug
	'workbench.view.extension.test', // Testing
];

/**
 * View containers that start in the bottom half of the Secondary Side Bar, until the user moves
 * any. The bottom icon group of its rail shows them above Manage.
 */
export const DEFAULT_AUXILIARYBAR_BOTTOM_VIEW_CONTAINERS: readonly string[] = [
	'workbench.view.extension.claude-sidebar-secondary', // Claude Code chat sessions
	'workbench.view.extension.github-pull-request', // GitHub Pull Request
	'workbench.view.extension.containersView', // Containers
	'workbench.view.extensions', // Extensions
];

/**
 * View containers that are not pinned when they first appear on a bar, so they stay hidden until
 * the user shows them.
 */
export const UNPINNED_BY_DEFAULT_VIEW_CONTAINERS: ReadonlySet<string> = new Set([
	'workbench.panel.chat', // Chat
	'workbench.view.extension.copilot-chat', // Chat Debug, from GitHub Copilot Chat
	'workbench.view.extension.gitlens', // GitLens
	'workbench.view.extension.gitlensInspect', // GitLens Inspect
]);
