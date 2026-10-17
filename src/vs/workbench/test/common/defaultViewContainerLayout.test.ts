/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { DEFAULT_AUXILIARYBAR_BOTTOM_VIEW_CONTAINERS, DEFAULT_SIDEBAR_BOTTOM_VIEW_CONTAINERS, getDefaultViewContainerPlacement } from '../../common/defaultViewContainerLayout.js';
import { ViewContainerLocation } from '../../common/views.js';

suite('DefaultViewContainerLayout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const CLAUDE_CODE_USAGE = 'workbench.view.extension.claude-sessions-sidebar';
	const CLAUDE_CODE_CHAT_SESSIONS = 'workbench.view.extension.claude-sidebar-secondary';

	/**
	 * The orders the built-in view containers of the bottom halves register with.
	 */
	const BUILT_IN_ORDERS: ReadonlyMap<string, number> = new Map([
		['workbench.view.debug', 3],
		['workbench.view.extensions', 4],
		['workbench.view.extension.test', 6],
	]);

	/**
	 * Orders a bottom half's view containers the way its icon group does. Extension view containers
	 * are contributed with orders after the built-in ones, as the views extension point assigns them.
	 */
	function iconGroupOrder(viewContainerIds: readonly string[], location: ViewContainerLocation): string[] {
		const firstExtensionOrder = location === ViewContainerLocation.AuxiliaryBar ? 101 : 7;
		const order = (id: string, index: number) => BUILT_IN_ORDERS.get(id) ?? getDefaultViewContainerPlacement(id, location, firstExtensionOrder + index).order;
		return viewContainerIds
			.map((id, index) => ({ id, order: order(id, index) }))
			.sort((a, b) => a.order - b.order)
			.map(({ id }) => id);
	}

	test('Claude Code usage and chat sessions start on top of the bottom left and bottom right corners', () => {
		assert.deepStrictEqual({
			usage: getDefaultViewContainerPlacement(CLAUDE_CODE_USAGE, ViewContainerLocation.Sidebar, 9),
			chatSessions: getDefaultViewContainerPlacement(CLAUDE_CODE_CHAT_SESSIONS, ViewContainerLocation.AuxiliaryBar, 101),
			bottomLeft: iconGroupOrder(DEFAULT_SIDEBAR_BOTTOM_VIEW_CONTAINERS, ViewContainerLocation.Sidebar),
			bottomRight: iconGroupOrder(DEFAULT_AUXILIARYBAR_BOTTOM_VIEW_CONTAINERS, ViewContainerLocation.AuxiliaryBar),
		}, {
			usage: { location: ViewContainerLocation.Sidebar, order: 2.5 },
			chatSessions: { location: ViewContainerLocation.AuxiliaryBar, order: 2.5 },
			bottomLeft: [
				CLAUDE_CODE_USAGE,
				'workbench.view.debug',
				'workbench.view.extension.test',
			],
			bottomRight: [
				CLAUDE_CODE_CHAT_SESSIONS,
				'workbench.view.extension.github-pull-request',
				'workbench.view.extension.containersView',
				'workbench.view.extensions',
			],
		});
	});

	test('other extension view containers keep the location and order they are contributed with', () => {
		assert.deepStrictEqual({
			github: getDefaultViewContainerPlacement('workbench.view.extension.github-pull-requests', ViewContainerLocation.Sidebar, 8),
			other: getDefaultViewContainerPlacement('workbench.view.extension.other', ViewContainerLocation.Sidebar, 8),
			otherInPanel: getDefaultViewContainerPlacement('workbench.view.extension.other', ViewContainerLocation.Panel, 6),
		}, {
			github: { location: ViewContainerLocation.AuxiliaryBar, order: 8 },
			other: { location: ViewContainerLocation.Sidebar, order: 8 },
			otherInPanel: { location: ViewContainerLocation.Panel, order: 6 },
		});
	});
});
