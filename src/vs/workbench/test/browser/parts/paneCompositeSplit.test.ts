/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getBottomPaneHeight, PaneCompositeSlots } from '../../../browser/parts/paneCompositeSplit.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { TestStorageService } from '../../common/workbenchTestServices.js';

suite('PaneCompositeSplit', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const STORAGE_KEY = 'test.bottom.viewContainers';

	function createSlots(store: DisposableStore, storageService = store.add(new TestStorageService())) {
		const onDidChangeContainerLocation = store.add(new Emitter<{ viewContainer: ViewContainer; from: ViewContainerLocation; to: ViewContainerLocation }>());
		const viewDescriptorService = new class extends mock<IViewDescriptorService>() {
			override onDidChangeContainerLocation = onDidChangeContainerLocation.event;
		};
		const slots = store.add(new PaneCompositeSlots(ViewContainerLocation.Sidebar, STORAGE_KEY, storageService, viewDescriptorService));
		let changes = 0;
		store.add(slots.onDidChange(() => changes++));
		const moveContainer = (id: string, from: ViewContainerLocation, to: ViewContainerLocation) => onDidChangeContainerLocation.fire({ viewContainer: { id } as ViewContainer, from, to });
		return { slots, storageService, moveContainer, changes: () => changes };
	}

	test('bottom pane height keeps both halves at the minimum when there is room', () => {
		const minimum = 100;
		assert.deepStrictEqual({
			half: getBottomPaneHeight(800, 0.5, minimum),
			mostlyBottom: getBottomPaneHeight(800, 0.9, minimum),
			clampedBottom: getBottomPaneHeight(800, 0.99, minimum),
			clampedTop: getBottomPaneHeight(800, 0.01, minimum),
			rounded: getBottomPaneHeight(801, 0.5, minimum),
			tooSmallForBoth: getBottomPaneHeight(150, 0.9, minimum),
			exactlyBoth: getBottomPaneHeight(200, 0.9, minimum),
			empty: getBottomPaneHeight(0, 0.5, minimum),
		}, {
			half: 400,
			mostlyBottom: 700,
			clampedBottom: 700,
			clampedTop: 100,
			rounded: 401,
			tooSmallForBoth: 75,
			exactlyBoth: 100,
			empty: 0,
		});
	});

	test('slots move view containers between halves, persist and notify once per change', () => {
		const { slots, storageService, changes } = createSlots(disposables.add(new DisposableStore()));

		slots.setInBottom('scm', true);
		slots.setInBottom('scm', true); // no-op
		slots.setInBottom('extensions', true);
		slots.setInBottom('extensions', false);

		assert.deepStrictEqual({
			scm: slots.isInBottom('scm'),
			extensions: slots.isInBottom('extensions'),
			explorer: slots.isInBottom('explorer'),
			stored: JSON.parse(storageService.get(STORAGE_KEY, StorageScope.PROFILE, '[]')),
			changes: changes(),
		}, {
			scm: true,
			extensions: false,
			explorer: false,
			stored: ['scm'],
			changes: 3,
		});
	});

	test('slots restore from storage, ignore malformed values, and follow storage changes', () => {
		const store = disposables.add(new DisposableStore());
		const storageService = store.add(new TestStorageService());
		storageService.store(STORAGE_KEY, JSON.stringify(['scm', 42, 'search']), StorageScope.PROFILE, StorageTarget.USER);

		const { slots, changes } = createSlots(store, storageService);
		const restored = { scm: slots.isInBottom('scm'), search: slots.isInBottom('search') };

		// another window changes the stored value
		storageService.store(STORAGE_KEY, JSON.stringify(['search']), StorageScope.PROFILE, StorageTarget.USER);
		const afterExternalChange = { scm: slots.isInBottom('scm'), search: slots.isInBottom('search'), changes: changes() };

		const malformed = disposables.add(new DisposableStore());
		const malformedStorage = malformed.add(new TestStorageService());
		malformedStorage.store(STORAGE_KEY, '{not json', StorageScope.PROFILE, StorageTarget.USER);
		const { slots: malformedSlots } = createSlots(malformed, malformedStorage);

		assert.deepStrictEqual({
			restored,
			afterExternalChange,
			malformed: malformedSlots.isInBottom('scm'),
		}, {
			restored: { scm: true, search: true },
			afterExternalChange: { scm: false, search: true, changes: 1 },
			malformed: false,
		});
	});

	test('a view container leaving the location also leaves the bottom half', () => {
		const { slots, moveContainer } = createSlots(disposables.add(new DisposableStore()));
		slots.setInBottom('scm', true);
		slots.setInBottom('search', true);

		moveContainer('scm', ViewContainerLocation.Sidebar, ViewContainerLocation.Panel);
		moveContainer('search', ViewContainerLocation.Panel, ViewContainerLocation.AuxiliaryBar); // another location's move

		assert.deepStrictEqual({ scm: slots.isInBottom('scm'), search: slots.isInBottom('search') }, { scm: false, search: true });
	});
});
